'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopAPI', {
    getState: () => ipcRenderer.invoke('desktop:getState'),
    syncWorkspace: () => ipcRenderer.invoke('desktop:syncWorkspace'),
    runSetup: force => ipcRenderer.invoke('desktop:runSetup', force),
    complete: () => ipcRenderer.invoke('desktop:complete'),
    openPath: p => ipcRenderer.invoke('desktop:openPath', p),
    openExternal: url => ipcRenderer.invoke('desktop:openExternal', url),
    onEvent: cb => {
        ipcRenderer.on('desktop:event', (_e, payload) => cb(payload))
    }
})
