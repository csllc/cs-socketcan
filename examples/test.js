const Can = require('..');

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

