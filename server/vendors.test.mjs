import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VENDOR_ADAPTERS,
  VENDORS_BY_ID,
  buildVendorUrl,
  publicVendors,
} from './vendors.mjs';

const common = {
  username: 'admin',
  password: 'secret',
  host: '192.168.1.64',
  port: 554,
  channel: 1,
  stream: 'sub',
};

test('vendor ids are unique and required adapters exist', () => {
  const ids = VENDOR_ADAPTERS.map((vendor) => vendor.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['hikvision', 'dahua', 'uniview', 'reolink', 'axis', 'custom']) {
    assert.ok(VENDORS_BY_ID.has(id), `missing adapter: ${id}`);
  }
});

test('Hikvision channel and substream path', () => {
  const vendor = VENDORS_BY_ID.get('hikvision');
  assert.equal(
    buildVendorUrl(vendor, { ...common, channel: 1, stream: 'sub' }),
    'rtsp://admin:secret@192.168.1.64:554/Streaming/Channels/102',
  );
  assert.equal(
    buildVendorUrl(vendor, { ...common, channel: 12, stream: 'main' }),
    'rtsp://admin:secret@192.168.1.64:554/Streaming/Channels/1201',
  );
});

test('Dahua channel and subtype path', () => {
  const vendor = VENDORS_BY_ID.get('dahua');
  assert.equal(
    buildVendorUrl(vendor, { ...common, channel: 5, stream: 'main' }),
    'rtsp://admin:secret@192.168.1.64:554/cam/realmonitor?channel=5&subtype=0',
  );
  assert.equal(
    buildVendorUrl(vendor, { ...common, channel: 5, stream: 'sub' }),
    'rtsp://admin:secret@192.168.1.64:554/cam/realmonitor?channel=5&subtype=1',
  );
});

test('Uniview and Reolink templates', () => {
  assert.equal(
    buildVendorUrl(VENDORS_BY_ID.get('uniview'), {
      ...common,
      channel: 3,
      stream: 'sub',
    }),
    'rtsp://admin:secret@192.168.1.64:554/unicast/c3/s1/live',
  );
  assert.equal(
    buildVendorUrl(VENDORS_BY_ID.get('reolink'), {
      ...common,
      channel: 2,
      stream: 'main',
    }),
    'rtsp://admin:secret@192.168.1.64:554/h264Preview_02_main',
  );
});

test('single-channel adapters ignore channel numbering', () => {
  const axis = buildVendorUrl(VENDORS_BY_ID.get('axis'), {
    ...common,
    channel: 9,
  });
  assert.ok(axis.endsWith('/axis-media/media.amp'));
  assert.ok(VENDORS_BY_ID.get('axis').singleChannel);
});

test('custom template encodes credentials and replaces placeholders', () => {
  const url = buildVendorUrl(VENDORS_BY_ID.get('custom'), {
    ...common,
    username: 'user@site',
    password: 'p:a/ss',
    channel: 7,
    stream: 'main',
    template: 'rtsp://{user}:{password}@{host}:{port}/live/{channel}/{stream}/{streamNum}',
  });
  assert.equal(
    url,
    'rtsp://user%40site:p%3Aa%2Fss@192.168.1.64:554/live/7/main/0',
  );
});

test('custom template rejects non-RTSP values and newlines', () => {
  assert.throws(
    () =>
      buildVendorUrl(VENDORS_BY_ID.get('custom'), {
        ...common,
        template: 'http://{host}/live',
      }),
    /rtsp/i,
  );
  assert.throws(
    () =>
      buildVendorUrl(VENDORS_BY_ID.get('custom'), {
        ...common,
        template: 'rtsp://{host}/live\nInjected: true',
      }),
    /非法字符/,
  );
});

test('public vendor metadata does not expose builder functions', () => {
  const vendors = publicVendors();
  assert.ok(vendors.length >= 12);
  for (const vendor of vendors) {
    assert.equal(typeof vendor.build, 'undefined');
    assert.equal(typeof vendor.hint, 'string');
    assert.equal(typeof vendor.defaultPort, 'number');
  }
});
