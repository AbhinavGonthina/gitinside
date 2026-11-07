export const MAX_SIZE = 1024;

export class Interpreter {
  static parse(text: string): string[] {
    return text.split("\n");
  }

  static extract(text: string): string {
    return text.trim();
  }
}
