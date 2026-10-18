import 'dart:convert';
import 'dart:io';

import 'package:ansiwise_cli/plugins.dart';
import 'package:ansiwise_core/ansiwise_core.dart';
import 'package:ansiwise_core/testing.dart';

// Only the command's response is supplied by the Node fixture. Loading, resolving, running and
// recording the reporting row use the same engine and registry as the CLI binding suite.
Future<void> main() async {
  final input = jsonDecode(
    await stdin.transform(utf8.decoder).join(),
  ) as Map<String, dynamic>;
  final registry = compiledPlugins.activate(['ansiwise-kubernetes']);
  final results = <Object>[];
  for (final request in input['reports'] as List<dynamic>) {
    final row = Map<String, dynamic>.from(request['row'] as Map)
      ..remove('when');
    final program = loadProgram(
      jsonEncode({
        'name': 'plane-administrator-report',
        'roles': ['master'],
        'steps': [
          row,
          {
            'step': 'wait_for_command_output',
            'waiting_for': 'the next row',
            'command': 'plane-report-next',
            'answer': 'reached',
            'timeout_seconds': 1,
            'interval_seconds': 1,
            'on_failure': 'exit',
          },
        ],
      }),
      where: 'the Plane administrator reporting row',
    );
    final response = request['response'] as Map<String, dynamic>;
    final shell = FakeShell({
      input['command'] as String: CommandResult(
        exitCode: response['code'] as int,
        stdout: response['stdout'] as String,
        stderr: response['stderr'] as String,
        elapsed: Duration.zero,
      ),
    })..answers('plane-report-next', 'reached\n');
    final clock = FakeClock();
    final recorder = MemoryRecorder(clock);
    final record =
        await Runner(
          machine: Machine(
            shell: shell,
            files: FakeFiles(),
            http: FakeHttp(),
            clock: clock,
            entropy: FakeEntropy(),
          ),
          recorder: recorder,
          redactor: Redactor([]),
        ).run(
          program: ProgramResolver(registry).resolve(program),
          mode: Mode.run,
          header: RunRecord(
            id: const RunId('20261018T000000Z-1'),
            program: program.name,
            mode: Mode.run,
            argv: const ['ansiwise', 'plane-administrator-report'],
            start: clock.now(),
            stage: const Stage('prod'),
            role: const Role('master'),
            fqdn: const Fqdn('master.example.test'),
            commit: 'fixture',
            fingerprint: 'fixture',
          ),
        );
    results.add({
      'exit': record.exitCode,
      'clean': record.clean,
      'issues': record.issues,
      'standing': record.steps.first.standing.name,
      'fully_proven': record.fullyProven,
      'output': recorder.output,
      'closed': recorder.closed,
      'next_reached': shell.ran.contains('plane-report-next'),
    });
  }
  stdout.writeln(jsonEncode(results));
}
