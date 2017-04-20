import R from 'ramda';
import {
  app,
  ipcMain,
  BrowserWindow,
} from 'electron';
import devtron from 'devtron';
import * as settings from './settings';
import { saveProject, loadProjectList, loadProject, changeWorkspace, checkWorkspace } from './remoteActions';
import { checkArduinoIde, installPav, findPort, doTranspileForArduino, uploadToArduino } from './uploadActions';

app.setName('xod');

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win;

function createWindow() {
  // Create the browser window.
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    title: 'XOD IDE',
  });
  win.maximize();
  // and load the index.html of the app.
  win.loadURL(`file://${__dirname}/../index.html`);

  // Open the DevTools.
  // win.webContents.openDevTools();

  // Emitted when the window is closed.
  win.on('closed', () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    win = null;
  });
}

const subscribeRemoteAction = (processName, remoteAction) => {
  ipcMain.on(processName, (event, opts) => {
    event.sender.send(`${processName}:process`);
    remoteAction(opts,
      (data) => { event.sender.send(`${processName}:complete`, data); }
    );
  });
};

const onReady = () => {
  devtron.install();
  settings.setDefaults();

  // TODO: Replace actionTypes with constants (after removing webpack from this package)
  subscribeRemoteAction('saveProject', saveProject);
  subscribeRemoteAction('loadProjectList', loadProjectList);
  subscribeRemoteAction('loadProject', loadProject);
  subscribeRemoteAction('checkWorkspace', checkWorkspace);
  subscribeRemoteAction('changeWorkspace', changeWorkspace);

  ipcMain.on('UPLOAD_TO_ARDUINO',
    (event, payload) => {
      let percentage = 0;

      function reply(data) {
        percentage += data.percentage;
        event.sender.send('UPLOAD_TO_ARDUINO', R.merge(data, { percentage }));
      }

      const updateArduinoPaths = (ide, packages) => R.compose(
        settings.save,
        settings.setArduinoPackages(packages),
        settings.setArduinoIDE(ide),
        settings.load
      )();

      doTranspileForArduino(payload, reply)
        .then(R.applySpec({
          code: R.identity,
          port: () => findPort(payload.pab, reply),
        }))
        .then(R.tap(() => checkArduinoIde(updateArduinoPaths, reply)))
        .then(R.tap(() => installPav(payload.pab, reply)))
        .then(({ code, port }) => uploadToArduino(payload.pab, port, code, reply))
        .catch(reply);
    }
  );
  ipcMain.on('SET_ARDUINO_IDE',
    (event, payload) => R.compose(
      R.tap(
        () => event.sender.send('SET_ARDUINO_IDE', {
          code: 0,
          message: 'Path to Arduino IDE executable was changed.',
        })
      ),
      settings.save,
      settings.setArduinoIDE(payload.path),
      settings.load
    )()
  );

  createWindow();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', onReady);

// Quit when all windows are closed.
app.on('window-all-closed', app.quit);

app.on('activate', () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (win === null) {
    createWindow();
  }
});
