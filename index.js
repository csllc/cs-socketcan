'use strict';

const socketcan = require('socketcan');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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

// Error frame definitions, from Linux source at
// include/uapi/linux/can/error.h. The socketcan module enables reception of
// all error frames, and delivers them with .err set and the error class in .id.

// Error classes (bits of the frame's ID)
const CAN_ERR_LOSTARB = 0x002;   // lost arbitration
const CAN_ERR_CRTL = 0x004;      // controller problems, details in data[1]
const CAN_ERR_PROT = 0x008;      // protocol violations, details in data[2..3]
const CAN_ERR_ACK = 0x020;       // received no ACK on transmission
const CAN_ERR_BUSOFF = 0x040;    // bus off
const CAN_ERR_BUSERROR = 0x080;  // bus error
const CAN_ERR_RESTARTED = 0x100; // controller restarted
const CAN_ERR_CNT = 0x200;       // TX/RX error counters in data[6]/data[7]

// Controller problems (data[1])
const CAN_ERR_CRTL_RX_OVERFLOW = 0x01;
const CAN_ERR_CRTL_TX_OVERFLOW = 0x02;
const CAN_ERR_CRTL_RX_WARNING = 0x04;
const CAN_ERR_CRTL_TX_WARNING = 0x08;
const CAN_ERR_CRTL_RX_PASSIVE = 0x10;
const CAN_ERR_CRTL_TX_PASSIVE = 0x20;
const CAN_ERR_CRTL_ACTIVE = 0x40;  // recovered to error active state

// Protocol violation types (data[2])
const CAN_ERR_PROT_BIT = 0x01;
const CAN_ERR_PROT_FORM = 0x02;
const CAN_ERR_PROT_STUFF = 0x04;
const CAN_ERR_PROT_BIT0 = 0x08;
const CAN_ERR_PROT_BIT1 = 0x10;

// Protocol violation locations (data[3])
const CAN_ERR_PROT_LOC_CRC_SEQ = 0x08;
const CAN_ERR_PROT_LOC_CRC_DEL = 0x18;
const CAN_ERR_PROT_LOC_ACK = 0x19;

// Controller states as reported by `ip -details link show`, and the values
// errorStats() reports for them
const IP_CAN_STATES = {
  'ERROR-ACTIVE': 'error-active',
  'ERROR-WARNING': 'error-warning',
  'ERROR-PASSIVE': 'error-passive',
  'BUS-OFF': 'bus-off',
  'STOPPED': 'stopped',
  'SLEEPING': 'sleeping',
};

// Where to look for the iproute2 `ip` command. /usr/sbin and /sbin are often
// not in the PATH of non-root users.
const IP_COMMANDS = ['ip', '/usr/sbin/ip', '/sbin/ip'];

// How long to wait for `ip` before giving up on it, in milliseconds
const IP_TIMEOUT = 2000;

// Returns a new set of error statistics counters
function newErrorCounters() {
  return {
    since: null,
    txFrames: 0,
    rxFrames: 0,
    errorFrames: 0,
    errors: { bit: 0, stuff: 0, form: 0, crc: 0, ack: 0, other: 0 },
    arbitrationLost: 0,
    overruns: 0,
    busOff: 0,
    // Last state and error counters reported in error frames; used only if
    // they can't be read from the interface
    state: null,
    txErrorCounter: null,
    rxErrorCounter: null,
  };
}

// Returns which of the errors categories a bus error belongs in, given the
// error class, protocol violation type and protocol violation location
function classifyBusError(errClass, type, location) {
  if (errClass & CAN_ERR_ACK) {
    return 'ack';
  }
  if (type & (CAN_ERR_PROT_BIT | CAN_ERR_PROT_BIT0 | CAN_ERR_PROT_BIT1)) {
    return 'bit';
  }
  if (type & CAN_ERR_PROT_STUFF) {
    return 'stuff';
  }
  if (type & CAN_ERR_PROT_FORM) {
    return 'form';
  }
  if (location === CAN_ERR_PROT_LOC_CRC_SEQ || location === CAN_ERR_PROT_LOC_CRC_DEL) {
    return 'crc';
  }
  if (location === CAN_ERR_PROT_LOC_ACK) {
    return 'ack';
  }
  return 'other';
}

// Runs `ip` with the given arguments, trying each of IP_COMMANDS until one is
// found. Resolves with its output, or with null if it can't be run or fails.
let ipCommand; // the entry of IP_COMMANDS that was found to work
async function runIp(args) {
  for (const cmd of (ipCommand ? [ipCommand] : IP_COMMANDS)) {
    const { err, stdout } = await new Promise((resolve) => {
      execFile(cmd, args, { timeout: IP_TIMEOUT }, (err, stdout) => resolve({ err, stdout }));
    });
    if (err && err.code === 'ENOENT') {
      continue; // not found here; try the next one
    }
    ipCommand = cmd;
    return err ? null : stdout;
  }
  return null;
}


module.exports = class Socketcan extends Duplex {

  constructor(options) {
    super({ objectMode: true });

    this.setOptions(options);
    this.requestQueue = [];
    this.port = null;
    this.can = undefined;
    this.isReady = false;
    this.enableTimestamps = false;
    this._errorCounters = newErrorCounters();
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

        this._errorCounters = newErrorCounters();
        this._errorCounters.since = new Date();

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

      this._errorCounters.txFrames++;

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

  // Resolves with bus error statistics. The counters cover the time since the
  // port was opened (see .since). The state and error counters are read from
  // the interface if possible, otherwise they are the last ones reported in
  // an error frame. Fields whose value is not known are null.
  async errorStats() {
    const c = this._errorCounters;
    let state = null;
    let txErrorCounter = null;
    let rxErrorCounter = null;

    if (this.isOpen()) {
      const info = await this._readCanInfo();
      state = (info && IP_CAN_STATES[info.state]) || c.state;
      const berr = info && info.berr_counter;
      if (berr && typeof berr.tx === 'number' && typeof berr.rx === 'number') {
        txErrorCounter = berr.tx;
        rxErrorCounter = berr.rx;
      } else {
        txErrorCounter = c.txErrorCounter;
        rxErrorCounter = c.rxErrorCounter;
      }
    }

    const total = c.txFrames + c.rxFrames + c.errorFrames;

    return {
      since: c.since,
      txFrames: c.txFrames,
      rxFrames: c.rxFrames,
      errorFrames: c.errorFrames,
      errorPercent: total > 0 ? (c.errorFrames / total) * 100 : 0,
      errors: Object.assign({}, c.errors),
      arbitrationLost: c.arbitrationLost,
      overruns: c.overruns,
      busOff: c.busOff,
      state: state,
      txErrorCounter: txErrorCounter,
      rxErrorCounter: rxErrorCounter,
    };
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
    // Error frames are counted, not passed on as data
    if (msg.err) {
      this._onErrorFrame(msg);
      return;
    }

    this._errorCounters.rxFrames++;

    // The socketcan module only sets ext and rtr when they are true; always
    // set them, to match can-usb-com
    msg.ext = !!msg.ext;
    msg.rtr = !!msg.rtr;

    if (msg.buf) {
      msg.buf = Buffer.from(msg.buf);
    } else if (msg.data) {
      msg.buf = Buffer.from(msg.data);
    }
    this.emit('data', msg);
  }

  // Updates the error statistics from an error frame. One error frame can
  // report several things at once (e.g. a bus error and a resulting state
  // change), and some report only a state change, so only error frames that
  // report a bus error count towards errorFrames.
  _onErrorFrame(msg) {
    const c = this._errorCounters;
    const errClass = msg.id;
    const data = msg.data || msg.buf || [];
    const byte = (i) => (i < data.length ? data[i] : 0);

    if (errClass & CAN_ERR_LOSTARB) {
      c.arbitrationLost++;
    }

    if (errClass & CAN_ERR_CRTL) {
      const crtl = byte(1);
      if (crtl & (CAN_ERR_CRTL_RX_OVERFLOW | CAN_ERR_CRTL_TX_OVERFLOW)) {
        c.overruns++;
      }
      if (crtl & (CAN_ERR_CRTL_RX_PASSIVE | CAN_ERR_CRTL_TX_PASSIVE)) {
        c.state = 'error-passive';
      } else if (crtl & (CAN_ERR_CRTL_RX_WARNING | CAN_ERR_CRTL_TX_WARNING)) {
        c.state = 'error-warning';
      } else if (crtl & CAN_ERR_CRTL_ACTIVE) {
        c.state = 'error-active';
      }
    }

    if (errClass & (CAN_ERR_PROT | CAN_ERR_ACK | CAN_ERR_BUSERROR)) {
      c.errorFrames++;
      c.errors[classifyBusError(errClass, byte(2), byte(3))]++;
    }

    if (errClass & CAN_ERR_BUSOFF) {
      c.busOff++;
      c.state = 'bus-off';
    }

    if (errClass & CAN_ERR_RESTARTED) {
      c.state = 'error-active';
    }

    if (errClass & CAN_ERR_CNT) {
      c.txErrorCounter = byte(6);
      c.rxErrorCounter = byte(7);
    }
  }

  // Resolves with the CAN-specific details of the interface, as reported by
  // `ip -details -json link show` (state, berr_counter, bittiming, ...), or
  // with null if they aren't available (e.g. vcan, or no `ip` command)
  async _readCanInfo() {
    const output = await runIp(['-details', '-json', 'link', 'show', 'dev', this.port]);
    if (!output) {
      return null;
    }
    try {
      const link = JSON.parse(output)[0];
      return (link && link.linkinfo && link.linkinfo.info_data) || null;
    } catch {
      return null;
    }
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
