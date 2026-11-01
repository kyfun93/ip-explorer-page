(function (root) {
  const current = root.IP_CONFIG || {};
  root.IP_CONFIG = {
    url: current.url || "",
    anonKey: current.anonKey || "",
    sharedEmail: current.sharedEmail || ""
  };
})(globalThis);
