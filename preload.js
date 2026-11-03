const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadModel: (id) => ipcRenderer.invoke('load-model', id),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveKey: (key) => ipcRenderer.invoke('save-key', key),
  clearKey: () => ipcRenderer.invoke('clear-key'),
  transcribe: (audio, language, model) => ipcRenderer.invoke('transcribe', { audio, language, model }),
  suggest: (args) => ipcRenderer.invoke('suggest', args),
  pickCv: () => ipcRenderer.invoke('pick-cv'),
  clearCv: () => ipcRenderer.invoke('clear-cv'),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  listModels: () => ipcRenderer.invoke('list-models'),
  setModel: (kind, id) => ipcRenderer.invoke('set-model', kind, id),
  onSuggestionError: (cb) => ipcRenderer.on('suggestion-error', (_e, d) => cb(d)),
  onSuggestionChunk: (cb) => ipcRenderer.on('suggestion-chunk', (_e, d) => cb(d)),
  onSuggestionDone: (cb) => ipcRenderer.on('suggestion-done', (_e, d) => cb(d)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
});
