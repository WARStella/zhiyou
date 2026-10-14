function isPlaceholderPlace(place) {
  return !!place && (/^PLACEHOLDER(?:_|$)/i.test(String(place.dataSource || '')) || /[（(]占位[）)]/.test(String(place.name || '')))
}
module.exports = { isPlaceholderPlace }
