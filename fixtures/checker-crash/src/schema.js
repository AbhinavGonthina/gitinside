// The shape of zod's bundled `safeParse` (from a minified Storybook asset), which made
// TypeScript 5.6 throw while it printed the type of `this.safeParse` for an error message.
const result = (issues) => {
  if (!issues.length) return { success: true };
  return {
    success: false,
    get error() {
      if (this._error) return this._error;
      const error = new Error(issues.join(", "));
      return (this._error = error), this._error;
    },
  };
};

class Schema {
  constructor() {
    this.safeParse = this.safeParse.bind(this);
  }

  safeParse(data) {
    return result(Array.isArray(data) ? data : []);
  }
}

module.exports = { Schema };
