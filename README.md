# NodeJS SocketCAN Module

This module provides a NodeJS interface to the SocketCAN driver for Linux.

This module is meant to serve as a drop-in replacement for `can-usb-com`, allowing a Soccketcan-compatible adapter to be used in place of [GridConnect CAN-USB-COM](https://www.gridconnect.com/products/usb-can-interface-can-usb-com). This module was specifically developed to be used with [Copperhill Technologies' PiCAN2 hat](https://copperhilltech.com/pican-2-can-bus-interface-for-raspberry-pi/) for the [Raspberry Pi](https://www.raspberrypi.org/).

## Getting Started

The following assumes that [NodeJS](https://nodejs.org) is already installed. This module was developed using Node v12.18.4 for Raspberry Pi OS (Debian GNU/Linux) 10.6.

To install this module, run:
```
npm install @csllc/cs-socketcan
```

The following is a sample script that opens the CAN port, writes a single message to the bus, and listens for and prints received messages from the bus.

```js
const Can = require('@csllc/cs-socketcan');

let can = new Can({
  canRate: 250000,
});

can.list()
.then((ports) => {
  console.log(ports);
  return can.open(ports[0].path)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
});


can.on('data', function(msg) {
  console.log(JSON.stringify(msg, (key, value) => {
    if ((typeof value === 'number') && (key == "id")) {
      return value.toString(16).toUpperCase().padStart(8, '0');
    } else if (typeof value === 'number') {
      return value.toString(16).toUpperCase().padStart(2, '0');
    } else {
      return value;
    }
  }));
});


```

## Examples

JavaScript examples are available in the `examples` folder.

## Configuration

The constructor accepts an object that specifies the desired configuration. The CAN adapter is set up before the `open` method resolves, so once it is complete, the CAN interface is ready for use.

The default options are shown in the following example. Any of them may be omitted from the constructor's option object to use their default value.

```js
let can = new Can({

  // bit rate on the CAN bus
  canRate: 250000,

  // useful for testing, each sent packet is also received
  loopback: false,
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
 - `data` when an incoming CAN bus frame is received
 - `write` when an outgoing CAN bus frame is sent to the device (the event is emitted before the frame is actually sent on the bus)
 - `close` when the port is closed

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


## Development

Before updating or modifying this package, please

 - Lint any changes using `eslint`.
 - Confirm that unit tests pass, noting the exceptions described in the next section.

In order to run unit tests (`npm test`), at least one PCAN-USB device must be connected to the computer.

The `pingpong` test is currently configured to use `cs-socketcan` for one adapter, and `can-usb-com` for the other. These must be connected via a properly terminated bus.

Do not run any tests on a bus with active traffic, since receiving unexpected CAN packets may confuse the tests.

## Functionality Limitations

 - No hardware loopback support - loopback is implemented in this module by pushing messages back into the stream in the `write()` method
 - This module does not implement message filtering
