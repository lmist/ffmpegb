if (!self.location) {
  Object.defineProperty(self, "location", {
    value: { href: import.meta.url },
  });
}

await import("./worker.js");
