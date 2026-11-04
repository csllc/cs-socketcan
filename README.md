# NodeJS SocketCAN Module

This module provides a NodeJS interface to the SocketCAN driver for Linux.

This module is meant to serve as a drop-in replacement for `can-usb-com`, allowing a SocketCAN-compatible adapter to be used in place of [GridConnect CAN-USB-COM](https://www.gridconnect.com/products/usb-can-interface-can-usb-com). 

This module was developed to be used with [Copperhill Technologies' PiCAN2 hat](https://copperhilltech.com/pican-2-can-bus-interface-for-raspberry-pi/) for the [Raspberry Pi](https://www.raspberrypi.org/).

This is also compatible with Kvaser CAN adapters that are supported by the `kvaser_usb` Linux kernel module. This is typically available out of the box in desktop Linux distributions such as Ubuntu, but must be built separately in Raspbian / Raspberry Pi OS. A script is included to perform this task automatically; see the relevant section below for more information.

## Getting Started

This module requires Linux and NodeJS 22.22.2 or later (or 24.15.0 or later).

It depends on the [`socketcan`](https://github.com/sebi2k1/node-can) module, which is compiled from source when it is installed, so the native build tools must be installed first. On Debian or Raspberry Pi OS:
```
sudo apt install build-essential python3
```

To install this module, run:
```
npm install @csllc/cs-socketcan
```

The CAN interface must be configured and brought up before it is opened; see [Configuration](#configuration).

The following is a sample script that opens the CAN port, writes a single message to the bus, and listens for and prints received messages from the bus.

```js
const Can = require('@csllc/cs-socketcan');

let board = new Can({
  canRate: 250000,
});

board.list()
  .then(function(ports) {
    board.on('write', function(msg) {
      console.log('Write: ', msg);
    });

    board.on('data', function(msg) {
      console.log('Msg: ', msg.id.toString(16), msg.buf);
    });

    console.log('opening ', ports[0].path);
    return board.open(ports[0].path);

  })
  .then(function() {
    board.write({ id: 0x10EF8001, ext: true, buf: Buffer.from([0x45, 0x00, 0x00, 0x04, 0x00, 0x00]) });

  })
  .catch(function(err) {
    // Something went wrong...
    console.error(err);
    board.close();
    process.exit(-1);
  });

```

## Examples

JavaScript examples are available in the `examples` folder.

## Configuration

The constructor accepts an object that specifies the desired configuration. Once the `open` method resolves, the CAN interface is ready for use.

The bit rate is a property of the Linux network interface, and setting it needs root privileges, so this module does not set it; the `canRate` option is accepted for compatibility with `can-usb-com` but is not used. Configure the interface beforehand, for example:

```
sudo ip link set can0 type can bitrate 250000
sudo ip link set up can0
```

The default options are shown in the following example. Any of them may be omitted from the constructor's option object to use their default value.

```js
let can = new Can({

  // bit rate on the CAN bus (not used; see above)
  canRate: 250000,

  // useful for testing, each sent packet is also received
  loopback: false,

  // how often to check the status while the port is open, in milliseconds,
  // so that changes are noticed (and 'status' events emitted) even when no
  // frames are sent or received; 0 to only check when status() or
  // errorStats() is called. Each check runs `ip`.
  statusInterval: 1000,
  });
```

### Streaming

`cs-socketcan` extends the NodeJS stream interface, so it can be piped into other stream instances.

### Filtering

`cs-socketcan` does not currently support message filtering.

### JavaScript Events

The module emits the following events:

 - `open` when the serial port is successfully opened
 - `error` if an error occurs
 - `data` when an incoming CAN bus frame is received (error frames are not emitted; see [Error Statistics](#error-statistics))
 - `write` when an outgoing CAN bus frame is sent to the device (the event is emitted before the frame is actually sent on the bus)
 - `status` when the status of the port changes (see [Status](#status))
 - `close` when the port is closed

`close()` removes all listeners from the instance, including the application's, and stops anything piped from it. If the same instance is opened again, attach the listeners (and pipes) again after opening it. (`@csllc/cs-canbus-universal` does this for its own listeners, so listeners attached to it are not affected.)

To listen for the events, use the typical NodeJS EventEmitter pattern:

```js
  can.on('open', function(){
    console.log( 'CAN bus opened');
  })

  can.on('data', function(msg){
    console.log( msg );
  })

  can.on('close', function(err){
    if( err && err.disconnected ) {
      console.log( 'CAN bus disconnected' );
    }
    else {
      console.log( 'CAN bus closed by application' );
    }
  })

  can.on('error', function(err){
    console.log( 'CAN bus error: ', err );
  })
```

## API

This module's API functions generally return Promises, which are resolved or rejected when a request is complete. 

Refer to the [documentation on Promises](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) for details on how to chain requests together, detect errors, etc. 

Refer to the `socketcan` and `node-can` documentation for more information on the components used in this module.

### Error Statistics

`errorStats()` returns a Promise that resolves with bus error statistics. The object has the same fields in all of the CAN adapter modules used by `@csllc/cs-canbus-universal`; a field whose value is not available is `null`.

```js
{
  since: Date,            // when counting started (when the port was opened); null if never opened
  txFrames: 0,            // data/remote frames sent
  rxFrames: 0,            // data/remote frames received
  errorFrames: 0,         // bus errors (error frames on the bus) reported by the adapter
  errorPercent: 0,        // errorFrames / (txFrames + rxFrames + errorFrames) * 100; 0 if nothing was counted
  errors: {               // errorFrames by type; these add up to errorFrames
    bit: 0,               // bit errors, including bit0/bit1 errors
    stuff: 0,             // stuffing errors
    form: 0,              // form errors
    crc: 0,               // CRC errors
    ack: 0,               // acknowledgement errors (no ACK on transmission)
    other: 0,             // bus errors of an unreported or other type
  },
  arbitrationLost: 0,     // transmissions that lost arbitration (normal on a busy bus; not an error frame)
  overruns: 0,            // receive or transmit buffer overflows (frames were lost)
  busOff: 0,              // times the controller went bus-off
  state: 'error-active',  // 'error-active', 'error-warning', 'error-passive', 'bus-off', 'stopped', 'sleeping', or null
  txErrorCounter: 0,      // transmit error counter (TEC)
  rxErrorCounter: 0,      // receive error counter (REC)
}
```

The counters are reset when the port is opened, and cover only this instance: frames sent by this instance, frames this instance received (which include frames sent by other programs on the same interface), and error frames reported while it was open. After the port is closed, the counters keep their final values and `state`, `txErrorCounter` and `rxErrorCounter` are `null`.

In this module:

 - Error frames are reported by the kernel driver. Many drivers only report bus errors (as opposed to state changes) when bus error reporting is turned on, which is done when the interface is configured, e.g. `sudo ip link set can0 type can bitrate 250000 berr-reporting on`. Drivers that can't report bus errors, or report them without their type, leave `errors` at zero or count them as `other`.
 - `state`, `txErrorCounter` and `rxErrorCounter` are read from the interface with `ip -details -json link show` (from iproute2) if possible. Otherwise they are the last values reported in an error frame, and `null` until one is received. Virtual (`vcan`) interfaces have no state.
 - Error frames are counted, and are not emitted as `data` events.

### Status

`status()` returns a Promise that resolves with the status of the port. The object has the same fields in all of the CAN adapter modules used by `@csllc/cs-canbus-universal`; a field whose value is not available is `null`. Whenever the status changes, a `status` event is emitted with the new status.

```js
{
  port: 'can0',              // the port that is open (as passed to open()); null if closed
  connection: 'connected', // 'closed', 'connected', or 'disconnected' (the adapter stopped responding, e.g. was unplugged, while the port was open)
  state: 'error-active',   // 'error-active', 'error-warning', 'error-passive', 'bus-off', 'stopped', 'sleeping', or null
  bitrate: 250000,         // bit rate in use, in bit/s
}
```

`state` is the same as in [Error Statistics](#error-statistics), and is `null` unless `connection` is `'connected'`. A port that is `'disconnected'` stays that way until it is closed; `isConnected()` returns false for it.

```js
can.on('status', (status) => {
  console.log(status.connection, status.state);
});
```

In this module, `state` and `bitrate` are read from the interface with `ip -details -json link show` (from iproute2). If the interface doesn't report a state, `state` is the last one reported in an error frame, and `null` until one is received; virtual (`vcan`) interfaces have no state or bit rate. A bit rate change needs the interface to be brought down, which shows as `state: 'stopped'`. The adapter is taken to be disconnected when its network interface is removed (e.g. a USB adapter is unplugged); `isOpen()` still returns true until the port is closed.

## Using Kvaser Adapters on Rasbperry Pi

SocketCAN works with Kvaser CAN adapters that are supported by the `kvaser_usb` Linux kernel module. Older Raspberry Pi OS (formerly Raspbian) kernels did not include this module; check whether yours does with `modinfo kvaser_usb`. If it's missing, it can be built from source and installed separately.

The whole build and install process can be performed by running the script:

```
$ /path/to/node-modules/@csllc/cs-socketcan/tools/rpi-kvaser-usb.sh
```

This script identifies the currently running Raspberry Pi firmware and kernel versions, retrieves the corresponding kernel source archive, builds the kernel with `kvaser_usb` as a dynamically loaded module, and installs and loads the module. The last steps are run with `sudo` to elevate priveleges, and will prompt for a password.

Currently the script rebuilds the entire kernel, and not simply the missing module alone. This requires approximately 2 GB of free space and takes about 4 hours to complete on a Raspberry Pi 3 Model B.

The script can be run with a mounted external drive as its working directory if free space on the SD card isn't sufficient.

## Development

Before updating or modifying this package, please

 - Lint any changes using `npm run lint`.
 - Confirm that unit tests pass (`npm test`).

The unit tests need a CAN network interface that is up. No hardware is needed: a virtual CAN interface works, and is what the release workflow uses:

```
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan
sudo ip link set up vcan0
CAN_INTERFACE=vcan0 npm test
```

If `CAN_INTERFACE` is not set, the tests use the first CAN interface found. To test with real hardware, set it to that interface (e.g. `CAN_INTERFACE=can0`). Do not run the tests on a bus with active traffic, since receiving unexpected CAN packets may confuse the tests.

The `pingpong` example (`examples/pingpong.js`) uses `@csllc/cs-socketcan` for one adapter, and `@csllc/can-usb-com` for the other. These must be connected via a properly terminated bus. It also needs `@csllc/can-usb-com` and `@csllc/j1939`, which are not dev dependencies of this package; install them with `npm install --no-save @csllc/can-usb-com @csllc/j1939`.

## Distribution

The module is plain JavaScript. Its only native code is in the `socketcan` dependency, which is a Node-API addon compiled with `node-gyp` when it is installed.

### Releasing

Releases are published by the GitHub Actions workflow in `.github/workflows/release.yml`, which runs when a version tag is pushed:

 1. Optionally, run the tests locally against real hardware (the CI runners only have virtual CAN interfaces)
 1. `npm version patch` (or `minor` / `major`), which updates `package.json` and creates the tag `vX.Y.Z`
 1. `git push --follow-tags`

The workflow lints the code and runs the tests against a virtual CAN interface on Linux x64 and arm64 with NodeJS 22 and 24. It then publishes the package to npm. Publishing uses npm trusted publishing, so no npm token is stored in GitHub; the package's trusted publisher on npmjs.com must name this repository and the workflow file `release.yml`.

## Functionality Limitations

 - No hardware loopback support - loopback is implemented in this module by pushing messages back into the stream in the `write()` method
 - This module does not implement message filtering
 - This module does not set the bit rate (see [Configuration](#configuration))

## Licensing and Dependencies

This project is licensed under the MIT license - see the [LICENSE](LICENSE) file for details.

It uses [socketcan](https://github.com/sebi2k1/node-can), which is also MIT licensed.
