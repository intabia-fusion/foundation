const sveltePreprocess = require('svelte-preprocess')

module.exports = {
    preprocess: sveltePreprocess({
      // Keeps imports that only the markup uses; see platform-rig/bin/compile.js for why this is
      // here and not in tsconfig.
      typescript: { compilerOptions: { verbatimModuleSyntax: true } },
      scss: {
          // This is expected as svelte-preprocess hasn't fully migrated to the modern API yet
          silenceDeprecations: ['legacy-js-api']
      }
    })
};
