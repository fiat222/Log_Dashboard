(function () {
  "use strict";

  let apiBase = "/logstore/api";

  function configure(options = {}) {
    if (options.apiBase) apiBase = options.apiBase;
  }

  function toApiUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;
  }

  function apiGet(path, options = {}) {
    return fetch(toApiUrl(path), {
      credentials: "include",
      ...options,
      headers: {
        ...(options.headers || {}),
      },
    });
  }

  window.LogDashApi = {
    configure,
    apiGet,
    toApiUrl,
  };
})();
