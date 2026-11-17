# ⚠️ 本文件必须保存为 **UTF-8 with BOM**。
#    Windows PowerShell 5.1 读无 BOM 的 .ps1 时会按 GBK 解码，中文注释变成乱码，
#    进而报一堆看不懂的语法错误。用编辑器另存为时别把 BOM 去掉。
#
# B2 本机 CPU 冒烟训练（只验证管线，不产出可用模型）
#
# 用法（在 services\crowd 目录下）：
#   powershell -ExecutionPolicy Bypass -File tools\smoke_cpu.ps1 -Check   # 只体检，不装不跑
#   powershell -ExecutionPolicy Bypass -File tools\smoke_cpu.ps1          # 全流程
#
# 目的与边界：
#   · 证明"解压 → 转 YOLO → 训练 → 保存权重 → 标定"整条链路是通的；
#   · 500 张 × 5 轮在 CPU 上约 1.5 小时，**产出的权重视为废品**，不能上线；
#   · 真正的训练等 GPU（Kaggle / 租卡 / 实验室服务器），用同一批脚本、不加 --limit。
#
# 为什么每步都要自检：这条链路上出错的地方**都不会报错**——
# 图片少几张、标签对不上、类别号不是 0，训练照样跑完，只是模型废了。

param(
    [int]$Limit = 500,
    [int]$Epochs = 5,
    [int]$Imgsz = 640,
    [int]$Batch = 8,
    # 为什么默认放用户目录：C:\ 根目录默认只有管理员能建文件夹，普通用户会 access denied
    [string]$DataRoot = "$env:USERPROFILE\CrowdHuman",
    [string]$Downloads = "$env:USERPROFILE\Downloads",
    [string]$PipMirror = 'https://pypi.tuna.tsinghua.edu.cn/simple',
    [string]$TorchIndex = 'https://download.pytorch.org/whl/cpu',
    # 冒烟只解 train01（约 2.8 GB、5000 张）就够了。
    # 全部解压要多占约 10 GB —— 正式训练在 GPU 上做，没必要在这台机器上摊开。
    [switch]$AllZips,
    [switch]$SkipInstall,
    [switch]$SkipUnzip,
    [switch]$Check
)

# 为什么是 Continue 而不是 Stop：PowerShell 5.1 在 Stop 下会把**任何原生命令的
# stderr 输出**当成异常抛出（NativeCommandError）。而 `python -c "import torch"`
# 失败时正好把 traceback 写在 stderr —— 于是"检查依赖"这一步会直接把脚本打断，
# 看起来像脚本崩了。所以全局用 Continue，每个外部命令自己看 $LASTEXITCODE。
$ErrorActionPreference = 'Continue'
$ServiceDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ServiceDir -ErrorAction Stop

function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  !!  $text" -ForegroundColor Yellow }
function Die($text) { Write-Host "  XX  $text" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1 环境
Step '1/5 检查 Python 与依赖'
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { Die 'PATH 里没有 python。先装 Python 3.10+ 并勾选 Add to PATH。' }
$version = (& python --version) 2>&1
Ok "$version ($($py.Source))"

$missing = @()
foreach ($mod in @('torch', 'ultralytics', 'PIL')) {
    & python -c "import $mod" 2>$null
    if ($LASTEXITCODE -ne 0) { $missing += $mod }
}
if ($missing.Count -gt 0) {
    Warn ("缺少：" + ($missing -join ', '))
    if ($Check) {
        Write-Host '  （-Check 模式：不安装）'
        Write-Host "  正式跑时会执行："
        Write-Host "    python -m pip install pillow ultralytics -i $PipMirror"
        Write-Host "    python -m pip install torch torchvision --index-url $TorchIndex"
    } elseif (-not $SkipInstall) {
        Write-Host '  安装 pillow + ultralytics（会连带装上 CPU 版 torch，约 1GB）…'
        & python -m pip install --upgrade pip -i $PipMirror | Out-Null
        & python -m pip install pillow ultralytics -i $PipMirror
        if ($LASTEXITCODE -ne 0) { Die 'pip 安装失败。先确认能上网，或换镜像：-PipMirror https://pypi.org/simple' }
        # ultralytics 会拉 CPU 版 torch；再显式确认一次，避免拉到 CUDA 包（1.5GB 且用不上）
        & python -c "import torch; print('torch', torch.__version__)"
        if ($LASTEXITCODE -ne 0) {
            & python -m pip install torch torchvision --index-url $TorchIndex
            if ($LASTEXITCODE -ne 0) { Die 'torch 安装失败' }
        }
        Ok '依赖就绪'
    } else {
        Warn '已指定 -SkipInstall，缺少依赖时后续步骤会失败'
    }
} else {
    & python -c "import torch; print('  torch ' + torch.__version__ + ' / cuda=' + str(torch.cuda.is_available()))"
    Ok '依赖齐全'
}

if ($Check) {
    Write-Host "`n- Check 结束。正式运行去掉 -Check 即可。"
    exit 0
}

# ---------------------------------------------------------------- 2 数据
Step '2/5 检查下载的压缩包'
$need = @('CrowdHuman_train01.zip', 'annotation_train.odgt')
if ($AllZips) {
    $need += @('CrowdHuman_train02.zip', 'CrowdHuman_train03.zip',
               'CrowdHuman_val.zip', 'annotation_val.odgt')
}
$totalGB = 0
foreach ($f in $need) {
    $p = Join-Path $Downloads $f
    if (-not (Test-Path $p)) { Die "找不到 $p（用 -Downloads 指定实际目录）" }
    $totalGB += (Get-Item $p).Length / 1GB
}
Ok ('需要 {0} 个文件，合计 {1:N1} GB' -f $need.Count, $totalGB)
if (-not $AllZips) {
    Write-Host '  只解 train01 做冒烟；全量训练在 GPU 上做，用 -AllZips 才会解全部四个包。'
}

$trainLines = (Get-Content (Join-Path $Downloads 'annotation_train.odgt') | Measure-Object -Line).Lines
if ($trainLines -ne 15000) { Warn "annotation_train.odgt 应是 15000 行，实际 $trainLines 行 —— 可能没下完整" }
else { Ok 'annotation_train.odgt 15000 行' }
if ($AllZips) {
    if (-not (Test-Path (Join-Path $Downloads 'annotation_val.odgt'))) { Die '缺少 annotation_val.odgt' }
    $valLines = (Get-Content (Join-Path $Downloads 'annotation_val.odgt') | Measure-Object -Line).Lines
    if ($valLines -ne 4370) { Warn "annotation_val.odgt 应是 4370 行，实际 $valLines 行" }
    else { Ok 'annotation_val.odgt 4370 行' }
}

# ---------------------------------------------------------------- 3 解压
Step "3/5 解压到 $DataRoot"
if ($SkipUnzip) {
    Warn '已指定 -SkipUnzip，跳过'
} else {
    New-Item -ItemType Directory -Force -Path @((Join-Path $DataRoot 'train'), (Join-Path $DataRoot 'val')) -ErrorAction Stop | Out-Null

    $jobs = @(@{ zip = 'CrowdHuman_train01.zip'; dest = 'train' })
    if ($AllZips) {
        $jobs += @{ zip = 'CrowdHuman_train02.zip'; dest = 'train' }
        $jobs += @{ zip = 'CrowdHuman_train03.zip'; dest = 'train' }
        $jobs += @{ zip = 'CrowdHuman_val.zip';    dest = 'val'   }
    }

    foreach ($j in $jobs) {
        $dest = Join-Path $DataRoot $j.dest
        # ⚠️ 用**每个 zip 自己的标记文件**判断是否解过。
        # 不能按 `Images` 里的图片数判断：三个 train 包都解到同一个 train\Images，
        # 解完第一个之后后两个会被误判为"已解压"而整包跳过，最后只有 5000 张。
        $marker = Join-Path $dest ('.done_' + $j.zip)
        if (Test-Path $marker) { Ok "$($j.zip) 已解压过，跳过"; continue }
        Write-Host "  解压 $($j.zip)（约 $([math]::Round((Get-Item (Join-Path $Downloads $j.zip)).Length/1GB,1)) GB）…"
        # 用系统自带 tar（bsdtar）而不是 Expand-Archive：后者解 2—3GB 的 zip 会慢到怀疑人生
        & tar -xf (Join-Path $Downloads $j.zip) -C $dest
        if ($LASTEXITCODE -ne 0) { Die "解压 $($j.zip) 失败" }
        New-Item -ItemType File -Force -Path $marker -ErrorAction SilentlyContinue | Out-Null
        Ok "$($j.zip) 完成"
    }

    Copy-Item (Join-Path $Downloads 'annotation_train.odgt') (Join-Path $DataRoot 'train') -Force
    if ($AllZips) {
        Copy-Item (Join-Path $Downloads 'annotation_val.odgt') (Join-Path $DataRoot 'val') -Force
    }

    $trainImgs = (Get-ChildItem (Join-Path $DataRoot 'train\Images') -Filter *.jpg | Measure-Object).Count
    Ok "train\Images 现有 $trainImgs 张"
    if ($AllZips) {
        if ($trainImgs -ne 15000) { Warn "全量应是 15000 张 —— 某个 zip 没解完，或解压出来多了一层目录" }
    } elseif ($trainImgs -lt $Limit) {
        Warn "只有 $trainImgs 张，少于 -Limit $Limit，转换时会自动少取"
    }
}

# ---------------------------------------------------------------- 4 转换
Step "4/5 转换为 YOLO 单类数据集（取 $Limit 张）"
$outDir = Join-Path $DataRoot 'smoke'
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
& python tools/prepare_dataset.py --crowdhuman (Join-Path $DataRoot 'train') --limit $Limit --out $outDir --mode link
if ($LASTEXITCODE -ne 0) { Die '转换失败' }

$statsPath = Join-Path $outDir 'stats.json'
if (-not (Test-Path $statsPath)) { Die '没有生成 stats.json' }
$stats = Get-Content $statsPath -Raw | ConvertFrom-Json
$ch = $stats.sources.crowdhuman
if (-not $ch) { Die 'stats.json 里没有 crowdhuman 来源' }
Write-Host ("  图 {0} · 框 {1} · 缺图 {2} · 丢弃 {3}" -f $ch.images, $ch.boxes, $ch.missingImages, $ch.dropped)
if ($ch.missingImages -gt 0) {
    if ($AllZips) {
        Warn "有 $($ch.missingImages) 张图找不到 —— 目录层级多半不对，先别训练"
    } else {
        # 只解了 train01（5000 张），而 odgt 覆盖 15000 张，查不到是正常的
        Write-Host ("  注：{0} 条记录找不到图片，属正常 —— 只解了 train01，odgt 覆盖全部 15000 张。" -f $ch.missingImages) -ForegroundColor DarkGray
    }
}
if ($ch.boxes -lt ($Limit * 5)) { Warn '平均框数偏少，确认 odgt 与图片是同一批' }

# ---------------------------------------------------------------- 5 训练
Step "5/5 CPU 冒烟训练（$Epochs 轮 · $Imgsz 输入 · batch $Batch）"
$yaml = Join-Path $outDir 'person.yaml'
# 训练产物放到数据目录下，别塞进仓库：一次冒烟会产生 weights/ + 一堆 matplotlib 图
$projectDir = Join-Path $DataRoot 'runs'
Write-Host '  提示：CPU 上大约 2—4 秒/张，500 张 × 5 轮约 1.5 小时。想更快就把 -Limit 调到 200。'
Write-Host '  提示：如果卡在下载 yolo11n.pt，见脚本结尾的离线权重说明。'
& python train/finetune.py --data $yaml --imgsz $Imgsz --batch $Batch --epochs $Epochs --workers 0 --device cpu --project $projectDir --name yolo11n-person
if ($LASTEXITCODE -ne 0) { Die '训练失败（常见原因：yolo11n.pt 下载不下来，或用 -Limit 太少导致验证集为空）' }

$best = Join-Path $projectDir 'yolo11n-person\weights\best.pt'
if (Test-Path $best) {
    Ok "权重：$((Resolve-Path $best).Path)"
    Write-Host "`n冒烟完成。这个权重**不要上线**（500 张 × 5 轮，CPU）。"
    Write-Host '它的价值是：证明数据、标签、训练、保存四个环节都通了。'
    Write-Host ''
    Write-Host '下一步（有 GPU 时，换台机器同理）：'
    Write-Host "  python tools/prepare_dataset.py --crowdhuman $DataRoot\train --out $DataRoot\person"
    Write-Host "  python train/finetune.py --data $DataRoot\person\person.yaml --imgsz 1280 --batch 16 --epochs 60 --device 0"
} else {
    Warn "没找到 $best，去看 $projectDir 下的实际目录"
}

# ---------------------------------------------------------------- 附：离线权重
Write-Host "`n如果训练第一步卡在 'Downloading yolo11n.pt'（GitHub 连不上）：" -ForegroundColor DarkGray
Write-Host '  1) 去 Ultralytics 的 GitHub Releases 页找 yolo11n.pt —— 版本要和你 pip 装的 ultralytics 对得上' -ForegroundColor DarkGray
Write-Host '     （也可以用任何可信来源的官方 yolo11n.pt，它是公开权重）' -ForegroundColor DarkGray
Write-Host '  2) 存到 services\crowd\yolo11n.pt' -ForegroundColor DarkGray
Write-Host '  3) 训练命令加 --weights .\yolo11n.pt，本脚本则改用 -SkipInstall 前先手动放好' -ForegroundColor DarkGray
Write-Host '  服务端最终用的就是这个官方权重，与文件同源。' -ForegroundColor DarkGray
