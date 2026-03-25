import { path } from './repo-utils/path.js';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { initCmd } from './commands/init.js';
import { startCmd } from './commands/start.js';
import { stopCmd } from './commands/stop.js';
import { statusCmd } from './commands/status.js';
import { listCmd } from './commands/status.js';
import { runCmd } from './commands/run.js';
import { deliverCmd } from './commands/deliver.js';
import { sendCmd } from './commands/send.js';
import { chatCmd } from './commands/chat.js';
import { readFileSync } from './repo-utils/fs.js';

// Helper: wrap async action and handle errors uniformly
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapAction(fn: (...args: any[]) => Promise<void>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (...args: any[]) => {
    (fn(...args) as Promise<void>).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${msg}\n`);
      process.exit(1);
    });
  };
}

// Read version from package.json
const __dirname = path.dirname(path.toPosixPath(fileURLToPath(import.meta.url)));
const { version: pkgVersion } = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf8')) as { version: string };

const program = new Command('agent')
  .description('Agent runtime and lifecycle management')
  .version(`agent ${pkgVersion}`)

// Exit with code 2 on unknown commands/options
program.on('command:*', () => {
  process.stderr.write(`Error: unknown command '${program.args.join(' ')}'\n`);
  program.help({ error: true });
});

program
  .command('init <id>')
  .description('Initialize a new agent')
  .option('--kind <kind>', 'system | user', 'user')
  .option('--provider <name>', 'pai provider name (auto-resolved from pai config if omitted)')
  .action(wrapAction(initCmd));

program
  .command('start <id>')
  .description('Start an agent (subscribe to inbox)')
  .action(wrapAction(startCmd));

program
  .command('stop <id>')
  .description('Stop an agent (unsubscribe from inbox)')
  .action(wrapAction(stopCmd));

program
  .command('status [id]')
  .description('Show agent status')
  .option('--json', 'JSON output')
  .action(wrapAction(statusCmd));

program
  .command('list')
  .description('List all agents')
  .option('--json', 'JSON output')
  .action(wrapAction(listCmd));

program
  .command('run <id>')
  .description('Run the agent loop (consume inbox messages)')
  .action(wrapAction(runCmd));

program
  .command('deliver')
  .description('Deliver outbound messages')
  .option('--thread <path>', 'Thread path')
  .option('--consumer <name>', 'Consumer name')
  .action(wrapAction(deliverCmd));

program
  .command('send <id>')
  .description('Push an event into an agent inbox — shorthand for: thread push --thread <inbox> ... (same parameters, just resolves inbox path for you)')
  .requiredOption('--source <source>', 'Event source')
  .requiredOption('--type <type>', 'Event type (e.g. message, record)')
  .requiredOption('--content <content>', 'Event content (string or JSON)')
  .option('--subtype <subtype>', 'Event subtype (e.g. toolcall, error)')
  .action(wrapAction(sendCmd));

program
  .command('chat <id>')
  .description('[DEBUG] Interactive REPL that talks directly to an agent, bypassing xgw/notifier. Not a substitute for the normal flow — use for local development and LLM behaviour testing only.')
  .action(wrapAction(chatCmd));

program.exitOverride((err) => {
  // commander uses exit code 1 for --help/--version; use 2 for usage errors
  if (err.code === 'commander.unknownCommand' ||
      err.code === 'commander.unknownOption' ||
      err.code === 'commander.missingArgument' ||
      err.code === 'commander.missingMandatoryOptionValue' ||
      err.code === 'commander.invalidArgument') {
    process.exit(2);
  }
  process.exit(err.exitCode ?? 1);
});

program.parse();
