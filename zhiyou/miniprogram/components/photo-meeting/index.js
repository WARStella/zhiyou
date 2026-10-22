const api = require('../../utils/api')
const { createPhotoMeeting, initialState } = require('../../utils/photo-meeting')

Component({
  properties: { crewId: { type: String, value: '', observer(value, previous) { if (this.photo && value !== previous) this.photo.reset() } },
    myPoint: { type: Object, value: null } },
  data: initialState(),
  lifetimes: {
    attached() {
      this.photo = createPhotoMeeting({ wx, callApi: api.callApi,
        getCrewId: () => this.properties.crewId,
        getPoint: () => this.properties.myPoint,
        onState: patch => this.setData(patch),
        onSelect: point => this.triggerEvent('selected', point) })
    },
    detached() { if (this.photo) this.photo.dispose() },
  },
  pageLifetimes: { hide() { if (this.photo) this.photo.hide() } },
  methods: {
    choose() { return this.photo.choose() },
    recognize() { return this.photo.recognize() },
    search() { return this.photo.search() },
    onKeyword(e) { this.photo.keyword(e.detail.value) },
    useLine(e) { this.photo.keyword(e.currentTarget.dataset.text) },
    select(e) { return this.photo.select(e.currentTarget.dataset.id) },
    preview(e) { return this.photo.preview(e.currentTarget.dataset.id) },
    manual() { this.photo.reset(); this.triggerEvent('manual') },
    clear() { this.photo.reset() },
  },
})
