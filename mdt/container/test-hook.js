
/* mdt test hook (debug builds only): appended to maximo-js-api's compiled
   app/AppSwitcher.js inside the build container. Exposes the running
   Application as window.__mdt.app so `mdt state` / `mdt eval` can inspect
   pages and datasources. Not part of your framework edits or of releases. */
;(function () {
  try {
    if (typeof window === 'undefined' || typeof AppSwitcher === 'undefined') return;
    var m = (window.__mdt = window.__mdt || {});
    m.AppSwitcher = AppSwitcher;
    Object.defineProperty(m, 'app', {
      configurable: true,
      get: function () {
        try {
          return AppSwitcher.get().currentApp || null;
        } catch (e) {
          return null;
        }
      }
    });
  } catch (e) {
    /* never break the app */
  }
})();
