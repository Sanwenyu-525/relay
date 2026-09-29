import viteConfig from '../../../../apps/workbench/vite.config';
export default {
  ...viteConfig,
  test: { environment:'jsdom', setupFiles:['./tests/setup.ts'], css:true,
    include:['../../docs/testing/evidence/overall-recheck-2026-09-28/title-refresh.spec.ts'] }
};
