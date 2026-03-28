import { Command, Option } from "clipanion";

export class EvalCommand extends Command {
  static paths = [["eval"]];
  static usage = Command.Usage({
    description: "Evaluate a JavaScript expression in a fresh context with libeam available",
    examples: [
      ["Run expression", 'libeam eval "console.log(1 + 1)"'],
      ["Use libeam APIs", 'libeam eval "import(\'libeam\').then(m => console.log(Object.keys(m)))"'],
    ],
  });

  expression = Option.String({ required: true, name: "expression" });

  async execute() {
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
        ...args: string[]
      ) => (libeam: unknown) => Promise<unknown>;
      const fn = new AsyncFunction("libeam", this.expression);
      const libeam = await import("../../index.js");
      await fn(libeam);
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.context.stderr.write(`[libeam] Eval error: ${error.message}\n`);
        if (error.stack) {
          this.context.stderr.write(`${error.stack}\n`);
        }
      } else {
        this.context.stderr.write(`[libeam] Eval error: ${String(error)}\n`);
      }
      return 1;
    }

    return 0;
  }
}
