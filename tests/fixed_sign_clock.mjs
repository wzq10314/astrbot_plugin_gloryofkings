// The upstream probe fixtures describe Saturday 2026-10-10, not the host's weekday.
// Apply only to tests via --import; production never imports this file.
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-10-10T08:00:00Z'])); }
  static now() { return RealDate.parse('2026-10-10T08:00:00Z'); }
};
