'use strict';

const socketcan = require('socketcan');
const fs = require('fs');
const path = require('path');

const { Duplex } = require('stream');


// Default configuration used unless overridden by caller
const DEFAULT_OPTIONS = {
  canRate: 250000,
  loopback: false,
};

// Network interfaces are listed in sysfs. We can't use os.networkInterfaces()
// because it only returns interfaces that have been assigned an IP address.
const SYSFS_NET = '/sys/class/net';

// Interface type for CAN, defined in Linux source at
// include/uapi/linux/if_arp.h
const ARPHRD_CAN = 280;


module.exports = class Socketcan extends Duplex {

  constructor(options) {
    super({ objectMode: true });

    this.setOptions(options);
    this.requestQueue = [];
    this.port = null;
    this.can = undefined;
    this.isReady = false;
    this.enableTimestamps = false;
  }

  // Sets (or re-sets) the configuration options
  setOptions(options) {
    // Save for later use. Copy the defaults so that they aren't changed.
    this.options = Object.assign({}, DEFAULT_OPTIONS, options);
  }

  // Returns a promise that resolves to a list of available CAN ports
  list() {
    return new Promise((resolve) => {
      if (process.platform != "linux") {
        resolve([]);
        return;
      }

      let channels = [];

      fs.readdirSync(SYSFS_NET).forEach((iface) => {
        let type;
        try {
          type = Number(fs.readFileSync(path.join(SYSFS_NET, iface, 'type'), 'utf8'));
        } catch {
          // The interface may have disappeared since the directory was read
          return;
        }
        if (type === ARPHRD_CAN) {
          channels.push({ path: iface });
        }
      });

      resolve(channels);
    });
  }

  open(port) {
    return new Promise((resolve, reject) => {
      // Initialize the CAN port (aka "channel")

      try {
        // Create the channel
        this.can = socketcan.createRawChannel(port, this.enableTimestamps);

        // Data receive event handler
        this.can.addListener("onMessage", this._onData.bind(this));

        // Start the bus
        this.can.start();

        this.port = port;
        this._configure();
        this.isReady = true;

        // Close event handler
        this.on('close', () => {
          this.close();
        });

        this.emit('open');

        resolve();
      } catch(err) {
        this.can = undefined;
        this.emit('error', err); // emit() instead of throw, matching CAN-USB-COM behavior
        reject(err);
      }
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      if (this.port === undefined) {
        reject(new Error("CAN port is undefined"));
        return;
      }
      // Remove listeners
      this.removeAllListeners();
      if (this.isOpen()) {
        // Close CAN port
        this.can.stop();
      }
      // Close stream
      this.emit('close');

      this.can = undefined;
      this.port = undefined;
      this.isReady = false;
      this.push(null);

      resolve();
    });
  }

  write(msg) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) {
        reject(new Error("CAN port is not open"));
        return;
      }

      // The CAN-USB-COM interface expects a .buf property that is
      // a <Buffer>, while the underlying 'socketcan' module expects
      // a .data property that is a <Buffer>. Since we may be looping this back
      // into the stream -and- writing this message to the bus, just duplicate
      // whichever property does exist in the msg object.
      if (msg.buf) {
        msg.buf = Buffer.from(msg.buf);
        msg.data = Buffer.from(msg.buf);
      } else if (msg.data) {
        msg.buf = Buffer.from(msg.data);
        msg.data = Buffer.from(msg.data);
      } else {
        msg.buf = Buffer.alloc(0);
        msg.data = Buffer.alloc(0);
      }

      if (msg.buf.length > 8) {
        reject(new Error("Tried to send invalid CAN data"));
        return;
      }

      // Write message to bus
      try {
        this.can.send(msg);
      } catch(err) {
        reject(err);
        return;
      }

      // If loopback is enabled, push message back into receive stream
      if (this.options.loopback) {
        this.push(msg);
      }

      this.emit('write', msg);

      resolve();
    });
  }

  status() {
    return new Promise((resolve, reject) => {
      if (this.port === undefined || this.port === null) {
        reject(new Error("CAN port is undefined"));
      } else {
        resolve({ port: this.port, open: !!this.isOpen() });
      }
    });
  }

  // Required function for cs-modbus GenericConnection
  isOpen() {
    return this.port && this.isReady;
  }

  // Required function for cs-modbus GenericConnection
  isConnected() {
    return this.isOpen();
  }

  _onData(msg) {
    if (msg.buf) {
      msg.buf = Buffer.from(msg.buf);
    } else if (msg.data) {
      msg.buf = Buffer.from(msg.data);
    }
    this.emit('data', msg);
  }

  // Required for a readable stream; we don't need to do anything
  _read() {}

  // Required for a writable stream. write() is overridden above, so this is
  // only reached through the stream internals (e.g. end(chunk)).
  _write(chunk, encoding, cb) {
    this.write(chunk).then(() => cb(), cb);
  }

  _configure() {

    return;
  }

};
