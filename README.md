# npm2jsr

This is a [JSR registry API](https://jsr.io/docs/api#jsr-registry-api)
compatible server that provides NPM modules transformed to JSR format. There is
a hosted instance available at https://npm2jsr.easrng.net. Use at your own risk,
it is very likely that I will need to ship changes that could break your
lockfiles.

## Usage

### Transforming NPM package names to npm2jsr package names

npm2jsr puts all the packages it generates under the `jsr:@npm` scope. To
convert an npm package name to the equivalent `jsr:@npm/`-namespaced package
name, follow these steps:

- Let `package_name` be the NPM package name to convert
- If `package_name` starts with `@`
  - Remove the initial `@` character from `package_name`
  - Assert that `package_name` contains exactly one `/` character
  - Split `package_name` on `/` into `scope` and `name`
  - Assert that `scope` does not contain `__`
  - Return `"@npm/scope__name"`
- Otherwise
  - Assert that `package_name` does not contain `/` or `__`
  - Return `"@npm/package_name"`

### HTTP Endpoints

- `/@npm/<encoded-package-name>/meta.json`\
  Version information in JSR format
- `/@npm/<encoded-package-name>/<version>_meta.json`\
  Export map and manifest for a specific version of a package in JSR format.
  Note that no `moduleGraph` is provided.
- `/@npm/<encoded-package-name>/<version>/<path>`\
  Serves files from the transformed package.
