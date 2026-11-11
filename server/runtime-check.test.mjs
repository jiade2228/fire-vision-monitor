import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_NODE_VERSION,
  assertNodeVersion,
  checkLongPathRisk,
  isNodeSupported,
  nodeVersionHint,
  parseNodeVersion,
} from './runtime-check.mjs';

/**
 * 运行时前置校验的边界。
 *
 * 依据：本项目依赖 node:sqlite（22.5.0+）。若版本判断写错，运维会看到
 * `Cannot find module 'node:sqlite'` 而非「请升级 Node」，因此这里把
 * 版本比较的边界值逐个钉死。
 */

test('parseNodeVersion：解析带 v 前缀与补丁号', () => {
  assert.deepEqual(parseNodeVersion('v22.22.2'), [22, 22, 2]);
  assert.deepEqual(parseNodeVersion('22.5.0'), [22, 5, 0]);
  assert.deepEqual(parseNodeVersion('20'), [20, 0, 0]);
});

test('parseNodeVersion：非法输入返回零值而不是抛错', () => {
  assert.deepEqual(parseNodeVersion(''), [0, 0, 0]);
  assert.deepEqual(parseNodeVersion(null), [0, 0, 0]);
  assert.deepEqual(parseNodeVersion('abc'), [0, 0, 0]);
});

test('isNodeSupported：22.5.0 是下界，其余边界正确', () => {
  const [major, minor, patch] = MIN_NODE_VERSION;
  assert.equal(isNodeSupported(`${major}.${minor}.${patch}`), true, '恰好等于下界应通过');
  assert.equal(isNodeSupported(`${major}.${minor}.0`), patch === 0);
  assert.equal(isNodeSupported(`${major}.${minor - 1}.99`), false, '小版本低于下界应拒绝');
  assert.equal(isNodeSupported(`${major - 1}.99.99`), false, '大版本低于下界应拒绝');
  assert.equal(isNodeSupported(`${major + 1}.0.0`), true, '更高大版本应通过');
  assert.equal(isNodeSupported('20.11.1'), false);
});

test('isNodeSupported：22.5.0 以下的具体回归点', () => {
  // node:sqlite 在 22.5.0 引入，22.4.x 必须被判为不支持。
  assert.equal(isNodeSupported('22.4.1'), false);
  assert.equal(isNodeSupported('18.20.0'), false);
});

test('assertNodeVersion：不满足时抛带指引的错误', () => {
  assert.throws(
    () => assertNodeVersion({ nodeVersion: '20.11.1' }),
    (error) => {
      assert.equal(error.code, 'NODE_VERSION_UNSUPPORTED');
      assert.match(error.message, /22\.5\.0/);
      assert.match(error.message, /node:sqlite/);
      return true;
    },
  );
  // 满足时返回解析结果
  const ok = assertNodeVersion({ nodeVersion: '22.22.2' });
  assert.deepEqual(ok.parsed, [22, 22, 2]);
});

test('nodeVersionHint：始终包含版本号与升级地址', () => {
  const hint = nodeVersionHint('20.0.0');
  assert.match(hint, /20\.0\.0/);
  assert.match(hint, /nodejs\.org/);
});

test('checkLongPathRisk：仅 Windows 且超过阈值时预警', () => {
  const short = checkLongPathRisk('D:\\fire\\data');
  assert.equal(short.risky, false);
  assert.ok(Number.isInteger(short.length));

  // 阈值 180：构造一个超长路径
  const long = checkLongPathRisk(`D:\\${'a'.repeat(200)}\\data`);
  assert.equal(long.length > long.limit, true);
  // 是否 risky 取决于运行平台，这里只校验字段语义
  assert.equal(typeof long.risky, 'boolean');
  if (process.platform !== 'win32') {
    assert.equal(long.risky, false, '非 Windows 不应报告长路径风险');
  }
});
