// Build-time maintenance only. Never invoke this in the request path.
const { Address4, Address6 } = require('ip-address');
if (!process.env.LICENSE_KEY) {
  console.error('Set LICENSE_KEY to your MaxMind license key before updating GeoLite data.');
  process.exit(1);
}
// geoip-lite 1.x's CSV converter uses the legacy method name. The patched
// parser returns a native BigInt; parseInt in the converter accepts it.
for (const Address of [Address4, Address6]) {
  if (!Address.prototype.bigInteger) Address.prototype.bigInteger = Address.prototype.bigInt;
}
require('geoip-lite/scripts/updatedb');
