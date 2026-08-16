const fs = require("fs-extra");
const path = require("path");
const { runCommand } = require("../lib/runCommand");
const { readTestFile } = require("../lib/testCache");
const { toTestResult } = require("../lib/sandbox");
const { SANDBOX_FLAGS } = require("../config");

// ============================================================================
// ASSUMPTION — NOT VERIFIED AGAINST THE ACTUAL manager.cpp.
//
// This wires manager <-> contestant with two named pipes and invokes:
//   ./manager_bin <fifo_c2m> <fifo_m2c>  < input.txt
//   ./contestant  < <fifo_m2c> > <fifo_c2m>
// which is the common CMS/IOI convention (manager takes the two FIFO
// paths as argv, reads the real test input on its own stdin, and the
// contestant only ever sees the FIFOs, never the input file directly).
//
// Individual tasks' managers are NOT perfectly standardized — some use
// extra CLI flags, a different argv order, or a numbered fd instead of
// argv paths. If this task's manager.cpp doesn't match this convention,
// submissions will run and finish (no crash) but be scored against the
// wrong interaction — silently wrong verdicts, not an error you'd notice
// from logs alone.
//
// BEFORE trusting this for real judging: run it against the reference
// solutions already bundled in this test package —
//   solutions/correct/jonathanirvings_ac.cpp   should score full marks
//   solutions/incorrect/*                      should score partial/zero
//   solutions/failed/*                         should come back RE/TLE
// If those don't come back as expected, the wiring below needs
// correcting against the real manager.cpp source.
// ============================================================================

async function compileCommunicationBinaries(ctx) {
  const { tmpDir, dockerImage, mem, testCacheDir } = ctx;
  const graderDir = path.join(testCacheDir, "graders");

  // Copies cards.h / manager.cpp / stub.cpp (or equivalent) from the
  // cached test package into the submission's temp dir, alongside the
  // contestant's own code (already written there by processJob before
  // this runs).
  await fs.copy(graderDir, tmpDir, { overwrite: true });

  const compileCmd = `docker run --rm --network none --memory=${mem}m ${SANDBOX_FLAGS} -v ${tmpDir}:/submission ${dockerImage} sh -c "cd /submission && g++ -O2 -o contestant solution.cpp stub.cpp 2>&1 && g++ -O2 -o manager_bin manager.cpp 2>&1"`;

  return runCommand(compileCmd, { maxBuffer: 10 * 1024 * 1024 });
}

async function executeCommunicationTest(ctx, test, testIndex) {
  const { tmpDir, dockerImage, mem, timeLimit, testCacheDir } = ctx;

  const sanitizedInput = (await readTestFile(testCacheDir, test.input_file, test.input)).trim();
  const sanitizedExpected = (
    await readTestFile(testCacheDir, test.expected_output_file, test.expected_output)
  ).trim();

  await fs.writeFile(path.join(tmpDir, "input.txt"), sanitizedInput);

  // Real multi-line script, not a one-liner — background-process
  // synchronization (`&` + `wait`) needs real statement separation, not
  // `&&` chaining, or the manager's background job silently doesn't get
  // waited on correctly.
  const wrapperScript = `#!/bin/sh
cd /submission
rm -f c2m m2c
mkfifo c2m m2c

./manager_bin c2m m2c < input.txt > manager_out.txt 2> manager_err.txt &
MANAGER_PID=$!

timeout ${timeLimit}s ./contestant < m2c > c2m
CONTESTANT_EXIT=$?

wait $MANAGER_PID
MANAGER_EXIT=$?

echo "CONTESTANT_EXIT:$CONTESTANT_EXIT"
echo "MANAGER_EXIT:$MANAGER_EXIT"
`;

  await fs.writeFile(path.join(tmpDir, "run.sh"), wrapperScript);

  const execCmd = `docker run --rm --network none --memory=${mem}m ${SANDBOX_FLAGS} -v ${tmpDir}:/submission ${dockerImage} sh /submission/run.sh`;

  const execRes = await runCommand(execCmd, { maxBuffer: 20 * 1024 * 1024 });

  const contestantExit = parseInt((execRes.out.match(/CONTESTANT_EXIT:(-?\d+)/) || [])[1] ?? "1", 10);
  const managerExit = parseInt((execRes.out.match(/MANAGER_EXIT:(-?\d+)/) || [])[1] ?? "1", 10);

  let testVerdict = "OK";
  if (execRes.code === 124 || contestantExit === 124) testVerdict = "TLE";
  else if (contestantExit !== 0) testVerdict = "RE";
  // The manager is the source of truth for correctness in a
  // communication task — a nonzero manager exit means it judged the
  // interaction wrong, independent of whether the contestant's own
  // process exited cleanly.
  else if (managerExit !== 0) testVerdict = "WA";

  return toTestResult(testVerdict, 0, 0, execRes.out, sanitizedInput, sanitizedExpected);
}

module.exports = { compileCommunicationBinaries, executeCommunicationTest };