/**
 * Test of basic functionality
 *
 * Needs a CAN network interface that is up. A virtual one works:
 *
 *   sudo modprobe vcan
 *   sudo ip link add dev vcan0 type vcan
 *   sudo ip link set up vcan0
 *
 * Set CAN_INTERFACE to pick the interface (e.g. CAN_INTERFACE=vcan0 npm test);
 * otherwise the first CAN interface found is used.
 */

const CsSocketcan = require('..');
const chai = require('chai');
const expect = chai.expect;
// Adds .should to all objects (used as can.should.emit())
chai.should();
chai.use(require('chai-events'));

const { Duplex } = require('stream');

const CAN_OPTIONS = {
  canRate: 250000,
};


const VCAN_HELP =
  'Set up a virtual one with:\n' +
  '  sudo modprobe vcan\n' +
  '  sudo ip link add dev vcan0 type vcan\n' +
  '  sudo ip link set up vcan0';

// Returns the name of the CAN interface to test with
async function getInterface(can) {
  let ports = (await can.list()).map((port) => port.path);

  if (process.env.CAN_INTERFACE) {
    if (!ports.includes(process.env.CAN_INTERFACE)) {
      throw new Error(`CAN interface ${process.env.CAN_INTERFACE} not found ` +
        `(found: ${ports.join(', ') || 'none'}). ${VCAN_HELP}`);
    }
    return process.env.CAN_INTERFACE;
  }
  if (ports.length === 0) {
    throw new Error(`No CAN interface found. ${VCAN_HELP}`);
  }
  return ports[0];
}

// Check for the interface once, up front, so that a missing interface gives
// one clear failure instead of a failure in every block
before(async () => {
  await getInterface(new CsSocketcan());
});

// Creates an instance and opens it
async function openCan(options) {
  let can = new CsSocketcan(options);
  let iface = await getInterface(can);
  let p = can.should.emit('open');
  await can.open(iface);
  await p;
  return can;
}


// Resolves with the next frame received by `can` that has the given ID, so
// that other traffic on the bus is ignored
function waitForFrame(can, id, timeout = 1000) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      can.removeListener('data', onData);
      reject(new Error(`Frame 0x${id.toString(16)} not received`));
    }, timeout);
    function onData(msg) {
      if (msg.id === id) {
        clearTimeout(timer);
        can.removeListener('data', onData);
        resolve(msg);
      }
    }
    can.on('data', onData);
  });
}


// Define a simple stream to send packet(s)
class SendStream extends Duplex {

  constructor() {
    super({ objectMode: true });
  }

  _read() {}

  _write(chunk, encoding, cb) {
    // increase the ID by one, just for giggles
    chunk.id++;

    this.push(chunk);
    cb();
  }

}

// Define a simple stream to receive packets
class ReceiveStream extends Duplex {

  constructor() {
    super({ objectMode: true });
  }

  _read() {}


  _write(chunk, encoding, cb) {
    // reduce the ID by one, just for giggles
    chunk.id--;

    this.push(chunk);
    cb();
  }

}


describe('List available devices', () => {

  it('should be at least one device', async () => {

    let can = new CsSocketcan(CAN_OPTIONS);

    let result = await can.list();

    expect(result).to.be.an('array');
    expect(result.length).to.be.gt(0);

    result.forEach((port) => {

      expect(port).to.be.an('object');
      expect(port.path).to.exist;

    });

  });
});


describe('Options', () => {

  it('should not share options between instances', () => {

    let can1 = new CsSocketcan({ loopback: true });
    let can2 = new CsSocketcan();

    expect(can1.options.loopback).to.be.eq(true);
    expect(can2.options.loopback).to.be.eq(false);
    expect(can2.options.canRate).to.be.eq(250000);
  });
});


describe('Closed port', () => {

  it('should reject a write', async () => {

    let can = new CsSocketcan(CAN_OPTIONS);

    let err = await can.write({ id: 0x100, ext: false, buf: [] }).catch((e) => e);
    expect(err).to.be.instanceof(Error);
  });

  it('should reject opening an interface that does not exist', async () => {

    let can = new CsSocketcan(CAN_OPTIONS);
    // the module emits 'error' as well as rejecting
    can.on('error', () => {});

    let err = await can.open('nosuchcan99').catch((e) => e);
    expect(err).to.be.instanceof(Error);
    expect(can.isOpen()).to.not.be.ok;
  });
});


describe('Send a Message', () => {

  let can = null;

  // before all tests in this block, get an open port
  before(async () => {
    // set and keep for later tests
    can = await openCan(CAN_OPTIONS);
  });

  it('should report its status', async () => {

    let status = await can.status();
    expect(status).to.have.all.keys('port', 'connection', 'state', 'bitrate');
    expect(status.connection).to.be.eq('connected');
    expect(status.port).to.be.a('string');
  });

  it('should send a message with standard identifier', async () => {

    let p = can.should.not.emit('error');

    // mainly we are checking that the write does not throw or error

    await can.write({ id: 0x100, ext: false, buf: [] });
    await can.write({ id: 0x101, ext: false, buf: [1] });
    await can.write({ id: 0x102, ext: false, buf: [1, 2] });
    await can.write({ id: 0x103, ext: false, buf: [1, 2, 3] });
    await can.write({ id: 0x104, ext: false, buf: [1, 2, 3, 4, 5] });
    await can.write({ id: 0x105, ext: false, buf: [1, 2, 3, 4, 5, 6] });
    await can.write({ id: 0x106, ext: false, buf: [1, 2, 3, 4, 5, 6, 7] });
    await can.write({ id: 0x107, ext: false, buf: [1, 2, 3, 4, 5, 6, 7, 8] });

    return p;

  });

  it('should send a message with the data in .data', async () => {

    await can.write({ id: 0x108, ext: false, data: Buffer.from([1, 2]) });
  });

  it('should reject more than 8 data bytes', async () => {

    let err = await can.write({ id: 0x100, ext: false, buf: [1, 2, 3, 4, 5, 6, 7, 8, 9] })
      .catch((e) => e);
    expect(err).to.be.instanceof(Error);
  });

  it('should emit a write event', async () => {

    let p = can.should.emit('write');

    can.write({
      id: 0x100,
      ext: false,
      buf: []
    });

    return p;
  });


  // after all tests in this block
  after(async () => {
    if (can) await can.close();
  });
});


describe('Receive a Message', () => {

  let can = null;

  // before all tests in this block, get an open port
  before(async () => {
    can = await openCan(CAN_OPTIONS);
  });


  it('should receive an extended message', (done) => {

    can.once('data', (msg) => {

      expect(msg).to.be.an('object');

      expect(msg.id).to.exist;
      expect(msg.ext).to.exist;
      expect(msg.buf).to.exist;
      expect(msg.id).to.be.eq(0x10EF8081);
      expect(msg.ext).to.be.eq(true);
      expect(msg.buf).to.deep.eq([1, 2, 3, 4, 5, 6, 7, 8]);

      done();

    });

    // here we simulate a receipt of a message by pushing it into the stream
    can.push({id: 0x10EF8081, ext: true, buf: [1, 2, 3, 4, 5, 6, 7, 8]});

  });

  it('should receive a standard message', (done) => {

    can.once('data', (msg) => {

      expect(msg).to.be.an('object');

      expect(msg.id).to.exist;
      expect(msg.ext).to.exist;
      expect(msg.buf).to.exist;
      expect(msg.id).to.be.eq(0x100);
      expect(msg.ext).to.be.eq(false);
      expect(msg.buf).to.deep.eq([8, 7, 6, 5, 4, 3, 2, 1]);

      done();

    });

    // here we simulate a receipt of a message by pushing it into the stream
    can.push({id: 0x100, ext: false, buf: [8, 7, 6, 5, 4, 3, 2, 1]});

  });

  // after all tests in this block
  after(async () => {
    if (can) await can.close();
  });
});


// Sends a frame from one instance and receives it on another instance on the
// same interface. SocketCAN delivers locally sent frames to the other sockets
// on the interface, so this goes through the socketcan module in both
// directions, and works on vcan as well as on real hardware.
describe('Send and receive through SocketCAN', () => {

  let tx = null;
  let rx = null;

  before(async () => {
    tx = await openCan(CAN_OPTIONS);
    rx = await openCan(CAN_OPTIONS);
  });

  it('should receive an extended frame sent by another socket', async () => {

    let p = waitForFrame(rx, 0x10EF8081);
    await tx.write({ id: 0x10EF8081, ext: true, buf: [1, 2, 3, 4, 5, 6, 7, 8] });
    let msg = await p;

    expect(msg.ext).to.be.eq(true);
    expect(msg.rtr).to.be.eq(false);
    expect(msg.buf).to.be.instanceof(Buffer);
    expect(msg.buf).to.deep.eq(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it('should receive a standard frame sent by another socket', async () => {

    let p = waitForFrame(rx, 0x123);
    await tx.write({ id: 0x123, ext: false, buf: [0xAA, 0x55] });
    let msg = await p;

    expect(msg.ext).to.be.eq(false);
    expect(msg.rtr).to.be.eq(false);
    expect(msg.buf).to.deep.eq(Buffer.from([0xAA, 0x55]));
  });

  it('should not receive its own frames', async () => {

    // rx receiving the frame shows that it was sent; tx should not get it
    let own = waitForFrame(tx, 0x124, 200).then(() => true, () => false);
    let p = waitForFrame(rx, 0x124);
    await tx.write({ id: 0x124, ext: false, buf: [] });
    await p;

    expect(await own).to.be.eq(false);
  });

  after(async () => {
    if (tx) await tx.close();
    if (rx) await rx.close();
  });
});


describe('Loopback Mode', () => {

  let can = null;

  // before all tests in this block, get an open port
  before(async () => {
    can = await openCan({ ...CAN_OPTIONS, loopback: true });
  });


  it('should loop back a packet', (done) => {

    // because we opened the port in loopback mode, the same
    // message shoud come out
    can.once('data', (msg) => {

      expect(msg).to.be.an('object');

      expect(msg.id).to.exist;
      expect(msg.ext).to.exist;
      expect(msg.buf).to.exist;
      expect(msg.buf).to.be.instanceof(Buffer);
      expect(msg.id).to.be.eq(0x100);
      expect(msg.ext).to.be.eq(false);
      expect(msg.buf).to.deep.eq(Buffer.from([]));

      done();
    });

    can.write({
      id: 0x100,
      ext: false,
      buf: []
    });

  });

  // after all tests in this block
  after(async () => {
    if (can) await can.close();
  });
});


// Fields of the object that errorStats() resolves with. This is common to all
// of the CAN adapter modules used by @csllc/cs-canbus-universal.
const ERROR_STATS_KEYS = [
  'since', 'txFrames', 'rxFrames', 'errorFrames', 'errorPercent', 'errors',
  'arbitrationLost', 'overruns', 'busOff', 'state', 'txErrorCounter',
  'rxErrorCounter',
];
const ERROR_TYPES = ['bit', 'stuff', 'form', 'crc', 'ack', 'other'];

// Builds an error frame as delivered by the socketcan module
function errorFrame(errClass, data = []) {
  let buf = Buffer.alloc(8);
  Buffer.from(data).copy(buf);
  return { id: errClass, err: true, data: buf };
}

describe('Error statistics', () => {

  it('should report empty statistics before the port is opened', async () => {

    let stats = await new CsSocketcan(CAN_OPTIONS).errorStats();

    expect(stats).to.have.all.keys(ERROR_STATS_KEYS);
    expect(stats.since).to.be.eq(null);
    expect(stats.txFrames).to.be.eq(0);
    expect(stats.rxFrames).to.be.eq(0);
    expect(stats.errorFrames).to.be.eq(0);
    expect(stats.errorPercent).to.be.eq(0);
    expect(stats.state).to.be.eq(null);
    expect(stats.txErrorCounter).to.be.eq(null);
    expect(stats.rxErrorCounter).to.be.eq(null);
  });

  describe('on an open port', () => {

    let tx = null;
    let rx = null;

    before(async () => {
      tx = await openCan(CAN_OPTIONS);
      rx = await openCan(CAN_OPTIONS);
    });

    it('should have the common fields', async () => {

      let stats = await tx.errorStats();

      expect(stats).to.have.all.keys(ERROR_STATS_KEYS);
      expect(stats.errors).to.have.all.keys(ERROR_TYPES);
      expect(stats.since).to.be.instanceof(Date);
      expect(stats.state === null || typeof stats.state === 'string').to.be.eq(true);
    });

    it('should count frames sent and received', async () => {

      let txBefore = await tx.errorStats();
      let rxBefore = await rx.errorStats();

      let p = waitForFrame(rx, 0x125);
      await tx.write({ id: 0x125, ext: false, buf: [1] });
      await p;

      let txAfter = await tx.errorStats();
      let rxAfter = await rx.errorStats();

      expect(txAfter.txFrames - txBefore.txFrames).to.be.eq(1);
      expect(rxAfter.rxFrames - rxBefore.rxFrames).to.be.gte(1);
    });

    it('should count and classify bus errors without passing them on as data', async () => {

      let before = await rx.errorStats();
      let received = 0;
      let onData = () => { received++; };
      rx.on('data', onData);

      // Error classes and data bytes from linux/can/error.h
      rx._onData(errorFrame(0x088, [0, 0, 0x04])); // stuff error
      rx._onData(errorFrame(0x088, [0, 0, 0x02])); // form error
      rx._onData(errorFrame(0x088, [0, 0, 0x10])); // bit1 error
      rx._onData(errorFrame(0x088, [0, 0, 0x00, 0x08])); // CRC sequence error
      rx._onData(errorFrame(0x0A0)); // no ACK
      rx._onData(errorFrame(0x080)); // unspecified bus error
      rx._onData(errorFrame(0x002)); // arbitration lost
      rx._onData(errorFrame(0x004, [0, 0x01])); // RX overflow

      rx.removeListener('data', onData);
      let after = await rx.errorStats();

      expect(received).to.be.eq(0);
      expect(after.errorFrames - before.errorFrames).to.be.eq(6);
      for (let type of ERROR_TYPES) {
        expect(after.errors[type] - before.errors[type], type).to.be.eq(1);
      }
      expect(after.arbitrationLost - before.arbitrationLost).to.be.eq(1);
      expect(after.overruns - before.overruns).to.be.eq(1);
      expect(after.rxFrames).to.be.eq(before.rxFrames);

      let total = after.txFrames + after.rxFrames + after.errorFrames;
      expect(after.errorPercent).to.be.closeTo(after.errorFrames / total * 100, 1e-9);
    });

    it('should track the state reported in error frames', async () => {

      // Use only what the error frames report, not what the interface reports
      let readCanInfo = rx._readCanInfo;
      rx._readCanInfo = async () => null;

      try {
        rx._onData(errorFrame(0x204, [0, 0x08, 0, 0, 0, 0, 100, 3])); // TX warning
        let stats = await rx.errorStats();
        expect(stats.state).to.be.eq('error-warning');
        expect(stats.txErrorCounter).to.be.eq(100);
        expect(stats.rxErrorCounter).to.be.eq(3);

        rx._onData(errorFrame(0x004, [0, 0x20])); // TX passive
        expect((await rx.errorStats()).state).to.be.eq('error-passive');

        let busOff = (await rx.errorStats()).busOff;
        rx._onData(errorFrame(0x040)); // bus off
        stats = await rx.errorStats();
        expect(stats.state).to.be.eq('bus-off');
        expect(stats.busOff - busOff).to.be.eq(1);

        rx._onData(errorFrame(0x100)); // restarted
        expect((await rx.errorStats()).state).to.be.eq('error-active');
      } finally {
        rx._readCanInfo = readCanInfo;
      }
    });

    after(async () => {
      if (tx) await tx.close();
      if (rx) await rx.close();
    });
  });
});


describe('Status', () => {

  const CLOSED = { port: null, connection: 'closed', state: null, bitrate: null };
  const STATES = ['error-active', 'error-warning', 'error-passive', 'bus-off', 'stopped', 'sleeping', null];

  it('should report a closed port before it is opened', async () => {

    expect(await new CsSocketcan(CAN_OPTIONS).status()).to.deep.eq(CLOSED);
  });

  it('should report and emit the status when the port is opened and closed', async () => {

    let can = new CsSocketcan(CAN_OPTIONS);
    let iface = await getInterface(can);
    let events = [];
    can.on('status', (status) => events.push(status));

    await can.open(iface);
    let status = await can.status();

    expect(status.port).to.be.eq(iface);
    expect(status.connection).to.be.eq('connected');
    expect(status.state).to.be.oneOf(STATES);
    // A virtual (vcan) interface has no bit rate
    expect(status.bitrate === null || typeof status.bitrate === 'number').to.be.eq(true);
    expect(events[events.length - 1]).to.deep.eq(status);

    await can.close();

    expect(await can.status()).to.deep.eq(CLOSED);
    expect(events[events.length - 1]).to.deep.eq(CLOSED);
  });

  it('should report a disconnected interface until the port is closed', async () => {

    let can = new CsSocketcan({ ...CAN_OPTIONS, statusInterval: 0 });
    let iface = await getInterface(can);
    await can.open(iface);
    await can.status();

    // What the socketcan module does when the interface is removed
    let p = new Promise((resolve) => can.once('status', resolve));
    can._stopping = false;
    can.can.stop();
    let status = await p;

    expect(status).to.include({ port: iface, connection: 'disconnected', state: null });
    expect(can.isConnected()).to.not.be.ok;
    expect(can.isOpen()).to.be.ok;

    await can.close();
    expect(await can.status()).to.deep.eq(CLOSED);
  });
});


describe('Implement a standard stream interface', () => {

  let can = null;

  let sender = new SendStream();
  let receiver = new ReceiveStream();

  // before all tests in this block, get an open port
  before(async () => {

    can = new CsSocketcan(CAN_OPTIONS);

    can.pipe(receiver);
    sender.pipe(can);

    let iface = await getInterface(can);

    let p = can.should.emit('open');

    await can.open(iface);

    return p;
  });


  it('should send a packet', async () => {

    let p = can.should.emit('write');

    sender.write({
      id: 0x100,
      ext: false,
      buf: [1, 2, 3, 4]
    });

    return p;


  });

  it('should receive a message', async () => {

    let p = receiver.should.emit('data');

    // here we simulate a receipt of a message from the socketcan module
    can._onData({ id: 0x100, ext: false, rtr: false, data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) });

    return p;
  });

  // after all tests in this block
  after(async () => {
    if (can) await can.close();
  });
});
