// Development harness: execute the tests against the actual image's deployed modules.
const Module = require('node:module');
const path = require('node:path');
const original = Module._resolveFilename;
const runtimeRequire = Module.createRequire(path.join(process.env.ISSUER_RUNTIME_DIR, '../package.json'));
Module._resolveFilename = function(request, parent, ...rest) {
  if (request.startsWith('../src/') && parent?.filename.startsWith('/tests/')) {
    return original.call(this, path.join(process.env.ISSUER_RUNTIME_DIR, request.slice('../src/'.length)), parent, ...rest);
  }
  // Dependencies may be installed under the workspace, as npm's lock specifies.
  if (parent?.filename.startsWith('/tests/') && !request.startsWith('.') && !path.isAbsolute(request)) {
    return runtimeRequire.resolve(request);
  }
  return original.call(this, request, parent, ...rest);
};
