import * as R from 'ramda';
import { tapP, delay as delayP } from 'xod-func-tools';

// =============================================================================
//
// Types
//
// =============================================================================

/**
 * PortInfo :: { path: PortName }
 * Plain object, that contains `path` (required field)
 * and other fields, that provided by connected device.
 */

/**
 * PortName :: String
 * A string pointer to portName.
 * E.G. `/dev/tty.usbmodem1421`, `COM4`.
 */

/**
 * Port :: SerialPort
 * It's an instance of SerialPort class.
 * See docs:
 * https://github.com/EmergingTechnologyAdvisors/node-serialport/blob/4.0.7/README.md
 */

/**
 * PortOptions :: Object
 * Plain object, that contains flags to be set to open port.
 * See docs:
 * https://github.com/EmergingTechnologyAdvisors/node-serialport/blob/4.0.7/README.md#set-options-callback
 */

// =============================================================================
//
// Utils
//
// =============================================================================

const delay = ms => () => delayP(ms);

// :: PortOptions -> Port -> Promise Port Error
const setPortOptions = R.curry(
  (options, port) =>
    new Promise((resolve, reject) => {
      port.set(options, err => {
        if (err) {
          reject(err);
        }
        resolve(port);
      });
    })
);

// :: Port -> Promise Port Error
const flushPort = port =>
  new Promise((resolve, reject) => {
    port.flush(err => {
      if (err) reject(err);
      resolve(port);
    });
  });

// =============================================================================
//
// Serial Port functions
//
// =============================================================================

/** Lists the available {@link Port}s.
 * @type {Function}
 * @return {Promise<Port[], Error>} */
// :: () -> [PortInfo]
export const listPorts = () => {
  // serialport is a native module that can conflict in ABI versions
  // with one built for Electron:
  //
  //   Error: The module '.../node_modules/serialport/build/Release/serialport.node'
  //   was compiled against a different Node.js version using
  //   NODE_MODULE_VERSION 53. This version of Node.js requires
  //   NODE_MODULE_VERSION 51. Please try re-compiling or re-installing
  //
  // Localize it’s require so that the conflict never arise if we’re
  // using CLI for things not related to serial port.
  //
  // eslint-disable-next-line global-require
  const SerialPort = require('serialport');

  return SerialPort.list();
};

// :: PortName -> PortOptions -> Promise Port Error
export const openPort = (portName, opts = {}) =>
  new Promise((resolve, reject) => {
    // eslint-disable-next-line global-require
    const SerialPort = require('serialport');

    try {
      const port = new SerialPort(portName, opts, err => 
        err ? reject(err) : resolve(port)
      );
      // port.on('error', reject);
      // port.on('open', () => resolve(port));
    } catch (err) {
      reject(err);
    }
  });

// :: Port -> Promise Port Error
export const closePort = port =>
  new Promise((resolve, reject) => {
    port.close(err => err ? reject(err) : resolve(port));
  });

// :: PortName -> Boolean -> (String -> *) -> (* -> *) -> Promise Port Error
export const openAndReadPort = (portName, disableRts, onData, onClose) => {
  // eslint-disable-next-line global-require
  const SerialPort = require('serialport');

  return openPort(portName, {
    baudRate: 115200,
    // This is an undocumented option that is true by default
    // and in Windows binding raises the DTR line when the device is opened
    // (see https://github.com/node-serialport/node-serialport/issues/1678),
    // which causes issues with some boards using CP2102 USB to Serial chip
    hupcl: false,
    rtscts: !disableRts,
  }).then(
    R.tap(port => {
      const parser = port.pipe(
        new SerialPort.parsers.Readline({ delimiter: '\n' })
      );

      parser.on('data', onData);
      port.on('close', onClose);
      port.on('error', err => console.dir(err, { depth: null }));
    })
  );
};

// :: PortName -> Promise Port Error
export const flushSerialBuffer = portName =>
  openPort(portName)
    .then(flushPort)
    .then(setPortOptions({ dtr: false, rts: false }))
    .then(tapP(delay(100)))
    .then(setPortOptions({ dtr: true, rts: true }))
    .then(closePort);

// :: PortName -> Promise Port Error
export const touchPort1200 = portName =>
  openPort(portName, { baudRate: 1200 })
    .then(setPortOptions({ dtr: false }))
    .then(closePort)
    .then(tapP(delay(400)));

// :: PortName -> Promise PortName Error
export const waitNewPort = async initialPorts => {
  let beforePorts = initialPorts;
  let elapsed = 0;
  const enumDelay = 50;

  while (elapsed < 10000) {
    const afterPorts = await listPorts();
    const diff = R.differenceWith(
      (a, b) => a.path === b.path,
      afterPorts,
      beforePorts
    );

    if (diff.length > 0) {
      await delay(200)();
      return diff[0].path;
    }

    beforePorts = afterPorts;
    await delay(enumDelay)();
    elapsed += enumDelay;
  }

  throw new Error('Board programming port did not appear');
};
