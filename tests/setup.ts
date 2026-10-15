/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {registerHooks} from 'node:module';
import path from 'node:path';
import {beforeEach, it} from 'node:test';

// Records if the test file loads DevTools through src/third_party/index.js.
let thirdPartyLoaded = false;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url.endsWith('/src/third_party/index.js')) {
      thirdPartyLoaded = true;
    }
    return result;
  },
});

// The polyfill imports src/third_party/index.js, which takes about half a
// second to load. Load it only on Node versions without DisposableStack.
// Register the hook above first, so that this import is also recorded.
if (!('DisposableStack' in globalThis)) {
  await import('../src/utils/polyfill.js');
}

// The root `before` hook runs before the test file is loaded, so check in
// `beforeEach`, which runs after it. Override the DevTools globals one time,
// and only for test files that load DevTools. Other test files do not pay
// for the large import.
let devToolsGlobalsOverridden = false;
beforeEach(async () => {
  if (devToolsGlobalsOverridden || !thirdPartyLoaded) {
    return;
  }
  devToolsGlobalsOverridden = true;
  const {overrideDevToolsGlobals} =
    await import('../src/devtools/DevtoolsUtils.js');
  overrideDevToolsGlobals({
    loadResource: async () => '',
  });
});

// This is run by Node when we execute the tests via the --import flag.
it.snapshot.setResolveSnapshotPath(testPath => {
  // By default the snapshots go into the build directory, but we want them
  // in the tests/ directory.
  const correctPath = testPath?.replace(path.join('build', 'tests'), 'tests');
  return correctPath + '.snapshot';
});

// The default serializer is JSON.stringify which outputs a very hard to read
// snapshot. So we override it to one that shows new lines literally rather
// than via `\n`.
it.snapshot.setDefaultSnapshotSerializers([String]);
