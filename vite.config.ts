import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const facebook = mode === 'facebook';
  return {
    base: './',
    resolve: { dedupe: ['pixi.js'] },
    build: { outDir: facebook ? 'dist-facebook' : 'dist' },
    define: { __FACEBOOK__: JSON.stringify(facebook) },
    plugins: [{
      name: 'reborn-facebook-sdk',
      transformIndexHtml() {
        if (!facebook) return;
        return [{
          tag: 'script',
          attrs: {
            id: 'facebook-sdk',
            src: 'https://connect.facebook.net/en_US/fbinstant.8.0.js',
            async: true,
          },
          injectTo: 'head',
        }];
      },
    }],
  };
});
