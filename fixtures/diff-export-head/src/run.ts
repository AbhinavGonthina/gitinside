import { Interpreter } from "./interpreter";
import { shout, whisper } from "./format";

export function run(text: string): string[] {
  return Interpreter.parse(shout(text));
}

export function quiet(text: string): string {
  return whisper(Interpreter.extract(text));
}
