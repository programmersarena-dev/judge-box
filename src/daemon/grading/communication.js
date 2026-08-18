const fs = require("fs-extra");
const path = require("path");
const { runCommand } = require("../lib/runCommand");
const { readTestFile } = require("../lib/testCache");
const { toTestResult } = require("../lib/sandbox");
const { SANDBOX_FLAGS } = require("../config");

async function compileCommunicationBinaries(ctx) {
  const { tmpDir, dockerImage, mem, testCacheDir, lang, jobFiles } = ctx;
  const graderDir = path.join(testCacheDir, "graders");

  await fs.copy(graderDir, tmpDir, { overwrite: true });

  const sourceExt = lang.extension || "cpp";
  const contestantSource = Object.keys(jobFiles).find((f) => f.endsWith(`.${sourceExt}`)) || `solution.${sourceExt}`;
  const hasStub = fs.existsSync(path.join(tmpDir, "stub.cpp"));

  let contestantCompileCmd = "";
  if (sourceExt === "cpp") {
    const stubArg = hasStub ? "stub.cpp" : "";
    contestantCompileCmd = `g++ -O2 -o /submission/contestant /submission/${contestantSource} ${stubArg ? `/submission/${stubArg}` : ""} 2>&1`;
  } else if (lang.commandCompile) {
    let cmd = lang.commandCompile;
    cmd = cmd.replace(/\/submission\/executable/g, "/submission/contestant");
    cmd = cmd.replace(/\/submission\/submission\.\w+/g, `/submission/${contestantSource}`);
    contestantCompileCmd = `${cmd} 2>&1`;
  } else {
    const wrapperPath = path.join(tmpDir, "contestant");
    const runCmd = lang.execute.replace(/\/submission\//g, "/submission/").replace(/\/submission\/executable/g, `/submission/${contestantSource}`);
    await fs.writeFile(wrapperPath, `#!/bin/sh\n${runCmd} "$@"\n`, { mode: 0o755 });
    contestantCompileCmd = `echo "wrapper"`;
  }

  const compileCmd = `docker run --rm --network none --memory=${mem}m ${SANDBOX_FLAGS} -v ${tmpDir}:/submission ${dockerImage} sh -c "cd /submission && ${contestantCompileCmd} && g++ -O2 -o /submission/manager_bin /submission/manager.cpp 2>&1"`;

  const compileRes = await runCommand(compileCmd, { maxBuffer: 10 * 1024 * 1024 });
  console.error(`[Comm] COMPILE job=${ctx.id} code=${compileRes.code} cmd=${compileCmd.slice(0, 200)}`);
  if (compileRes.code !== 0) {
    console.error(`[Comm] COMPILE OUTPUT: ${compileRes.out.slice(0, 3000)}`);
  }
  return compileRes;
}

async function executeCommunicationTest(ctx, test, testIndex) {
  const { tmpDir, dockerImage, mem, timeLimit, testCacheDir, id } = ctx;

  const sanitizedInput = (await readTestFile(testCacheDir, test.input_file, test.input)).trim();
  const sanitizedExpected = (
    await readTestFile(testCacheDir, test.expected_output_file, test.expected_output)
  ).trim();

  await fs.writeFile(path.join(tmpDir, "input.txt"), sanitizedInput);

  const wrapperScript = `#!/bin/sh
cd /submission
rm -f c2m_a m2c_a c2m_b m2c_b
mkfifo c2m_a m2c_a c2m_b m2c_b

./manager_bin c2m_a m2c_a c2m_b m2c_b < input.txt > manager_out.txt 2> manager_err.txt &
MANAGER_PID=$!

timeout ${timeLimit}s ./contestant 0 < m2c_a > c2m_a &
CONTESTANT_A_PID=$!

timeout ${timeLimit}s ./contestant 1 < m2c_b > c2m_b &
CONTESTANT_B_PID=$!

wait $CONTESTANT_A_PID
CONTESTANT_A_EXIT=$?

wait $CONTESTANT_B_PID
CONTESTANT_B_EXIT=$?

wait $MANAGER_PID
MANAGER_EXIT=$?

echo "CONTESTANT_A_EXIT:$CONTESTANT_A_EXIT"
echo "CONTESTANT_B_EXIT:$CONTESTANT_B_EXIT"
echo "MANAGER_EXIT:$MANAGER_EXIT"
`;

  await fs.writeFile(path.join(tmpDir, "run.sh"), wrapperScript);

  const execCmd = `docker run --rm --network none --memory=${mem}m ${SANDBOX_FLAGS} -v ${tmpDir}:/submission ${dockerImage} sh /submission/run.sh`;

  const execRes = await runCommand(execCmd, { maxBuffer: 20 * 1024 * 1024 });

  const lines = execRes.out.split("\n");
  const contestantAExit = parseInt((lines.find((l) => l.startsWith("CONTESTANT_A_EXIT:")) || "").split(":")[1] ?? "1", 10);
  const contestantBExit = parseInt((lines.find((l) => l.startsWith("CONTESTANT_B_EXIT:")) || "").split(":")[1] ?? "1", 10);
  const managerExit = parseInt((lines.find((l) => l.startsWith("MANAGER_EXIT:")) || "").split(":")[1] ?? "1", 10);

  let managerVerdict = "0";
  try {
    const managerOut = await fs.readFile(path.join(tmpDir, "manager_out.txt"), "utf8");
    managerVerdict = (managerOut.match(/^(\d+)/m) || [])[1] || "0";
  } catch (e) {
    managerVerdict = "0";
  }

  let testVerdict = "OK";
  if (execRes.code === 124 || contestantAExit === 124 || contestantBExit === 124) testVerdict = "TLE";
  else if (contestantAExit !== 0 || contestantBExit !== 0) testVerdict = "RE";
  else if (managerVerdict === "0") testVerdict = "WA";

  return toTestResult(testVerdict, 0, 0, execRes.out, sanitizedInput, sanitizedExpected);
}

module.exports = { compileCommunicationBinaries, executeCommunicationTest };
