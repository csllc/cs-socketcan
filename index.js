'use strict';

const socketcan = require('socketcan');
const shell = require('shelljs');
const path = require('path');

const { Duplex } = require('stream');



// Default configuration used unless overridden by caller
const DEFAULT_OPTIONS = {
  canRate: 250000,
};

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
    // Save for later use
    this.options = Object.assign(DEFAULT_OPTIONS, options);
  }

  // Returns a promise that resolves to a list of available CAN ports
  list() {
    return new Promise((resolve, reject) => {
      if (process.platform != "linux") {
        resolve([]);
      } else {
        // We can't use os.networkInterfaces() because it only returns
        // interfaces that have been assigned an IP address. Instead, we look
        // directly in sysfs.
        let sysfsInterfaces = '/sys/class/net';
        let channels = [];

        let interfaces = shell.ls(sysfsInterfaces);
        interfaces.forEach((iface) => {
          let type = Number(shell.cat(path.join(sysfsInterfaces, iface, "type")));
          if (type == 280) { // CAN, defined in Linux source at include/uapi/linux/if_arp.h
            channels.push({ path: iface });
          }
        });

        resolve(channels);
      }
    })
    .catch((err) => {
      throw err;
    });
  }

  open(port) {
    return new Promise((resolve, reject) => {
      // Initialize the CAN port (aka "channel")
      try {
        // Create the channel
        this.can = socketcan.createRawChannel(port, this.enableTimestamps);
        
        // Start the bus
        this.can.start();

        this.port = port;
        this._configure();
        this.isReady = true;
        this.emit('open');

        resolve();
      } catch(err) {
        this.emit('error', err); // emit() instead of throw, matching CAN-USB-COM behavior
        reject(err);
      }

    })
    .then(() => {
      // Close event handler
      this.on('close', function() {
        this.close();
      });

      // Data receive event handler
      this.can.addListener("onMessage", (msg) => {
        msg['buf'] = msg['data'];
        delete this['data'];
        this.emit('data', msg);
      });
    })
    .catch((err) => {
      throw err;
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      if (this.port === undefined) {
        reject(new Error("CAN port is undefined"))
      }
      // Remove listeners
      this.removeAllListeners();
      if (this.isOpen()) {
        // Close CAN port
        socketcan.stop();
      }
      // Close stream
      this.emit('close');
      resolve();
    })
    .then(() => {
      this.can = undefined;
      this.port = undefined;
      this.isReady = false;
      this.push(null);
    })
    .catch((err) => {
      throw err;
    });
  }

  write(msg) {
    return new Promise((resolve, reject) => {
      if (this.port === undefined) {
        reject(new Error("CAN port is undefined"));
      } else {
        if (msg.buf.length <= 8) {
          // Write message to bus
          msg['data'] = Buffer.from(msg['buf']);
          delete msg['buf'];
          try {
            this.can.send(msg);
          } catch(err) {
            reject(err);
          }
          
          this.emit('write', msg);

          // If loopback is enabled, push message back into receive stream
          if (this.options.loopback) {
            this.push(msg);
          }

          resolve();
        } else {
          reject(new Error("Tried to send invalid CAN data"));
        }
      }
    })
    .catch((err) => {
      throw err;
    });
  }
    
  status() {
    return new Promise((resolve, reject) => {
      if (this.port === undefined) {
        reject(new Error("CAN port is undefined"));
      } else {
        return this.status;
      }
    })
    .catch((err) => {
      throw err;
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

  // Required for a readable stream; we don't need to do anything
  _read() {}

  // Required for a writable stream; we don't need to do anything
  _write() {}

  _configure() {

    return;
  }

}
