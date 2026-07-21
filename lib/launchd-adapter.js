const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const {
  DEFAULT_LABEL,
  DEFAULT_BASE_DIR_NAME,
  normalizeLaunchdOptions,
  buildPathPlan,
  buildInstallPlan,
  buildAdapterConfig,
  validatePlistXml,
  validateLabel,
  hashPlist,
  normalizeStatusResult,
  backupPlistName,
  isAbsolutePath,
} = require("./launchd-core");

const EXIT = {
  OK: 0,
  FAILURE: 1,
  VALIDATION: 2,
  UNSUPPORTED: 3,
  CONFLICT: 4,
  PLIST_INVALID: 5,
  LAUNCHCTL: 6,
  STATUS: 7,
};

function defaultDeps(overrides = {}) {
  return {
    platform: overrides.platform || process.platform,
    homedir: overrides.homedir || (() => os.homedir()),
    getuid: overrides.getuid || (() => (typeof process.getuid === "function" ? process.getuid() : 501)),
    execPath: overrides.execPath || process.execPath,
    now: overrides.now || (() => new Date()),
    fs: overrides.fs || fs,
    path: overrides.path || path,
    spawnSync: overrides.spawnSync || spawnSync,
    launchAgentsDir: overrides.launchAgentsDir || null,
  };
}

function ensureDir(fsApi, dirPath) {
  fsApi.mkdirSync(dirPath, { recursive: true });
}

function writeAtomic(fsApi, pathApi, filePath, content, mode = 0o644) {
  const dir = pathApi.dirname(filePath);
  ensureDir(fsApi, dir);
  const tmpPath = pathApi.join(
    dir,
    `.${pathApi.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fsApi.writeFileSync(tmpPath, content, { encoding: "utf8", mode });
    fsApi.renameSync(tmpPath, filePath);
    try {
      fsApi.chmodSync(filePath, mode);
    } catch (_e) {
      // best-effort on platforms without chmod
    }
  } catch (error) {
    try {
      if (fsApi.existsSync(tmpPath)) fsApi.unlinkSync(tmpPath);
    } catch (_e) {
      // ignore
    }
    throw error;
  }
}

function assertDarwin(deps, allowNonDarwinGenerate = false) {
  if (deps.platform === "darwin") return;
  if (allowNonDarwinGenerate) return;
  const err = new Error(
    `Launchd Adapter は macOS (darwin) のみ対応です（現在: ${deps.platform}）。`
  );
  err.exitCode = EXIT.UNSUPPORTED;
  throw err;
}

function resolveProjectDir(rawProjectDir, projectRootHint, fsApi, pathApi) {
  // projectRootHint must be the project root (directory containing daily-runner.js)
  const candidate = rawProjectDir
    ? pathApi.resolve(rawProjectDir)
    : pathApi.resolve(projectRootHint || ".");
  if (!fsApi.existsSync(candidate) || !fsApi.statSync(candidate).isDirectory()) {
    throw Object.assign(new Error(`projectDir が存在しません: ${candidate}`), {
      exitCode: EXIT.VALIDATION,
    });
  }
  const dailyRunner = pathApi.join(candidate, "daily-runner.js");
  const packageJson = pathApi.join(candidate, "package.json");
  if (!fsApi.existsSync(dailyRunner)) {
    throw Object.assign(
      new Error(`daily-runner.js が見つかりません: ${dailyRunner}`),
      { exitCode: EXIT.VALIDATION }
    );
  }
  if (!fsApi.existsSync(packageJson)) {
    throw Object.assign(
      new Error(`package.json が見つかりません: ${packageJson}`),
      { exitCode: EXIT.VALIDATION }
    );
  }
  return candidate;
}

function resolveNodePath(rawNode, deps) {
  const nodePath = rawNode
    ? deps.path.resolve(rawNode)
    : deps.execPath;
  if (!isAbsolutePath(nodePath)) {
    throw Object.assign(new Error("Node.js パスは絶対パスである必要があります。"), {
      exitCode: EXIT.VALIDATION,
    });
  }
  if (!deps.fs.existsSync(nodePath)) {
    throw Object.assign(new Error(`Node.js が見つかりません: ${nodePath}`), {
      exitCode: EXIT.VALIDATION,
    });
  }
  const st = deps.fs.statSync(nodePath);
  if (!st.isFile()) {
    throw Object.assign(new Error(`Node.js が通常ファイルではありません: ${nodePath}`), {
      exitCode: EXIT.VALIDATION,
    });
  }
  try {
    deps.fs.accessSync(nodePath, deps.fs.constants.X_OK);
  } catch (_error) {
    throw Object.assign(new Error(`Node.js が実行可能ではありません: ${nodePath}`), {
      exitCode: EXIT.VALIDATION,
    });
  }
  return nodePath;
}

function resolveLaunchAgentsDir(deps) {
  if (deps.launchAgentsDir) {
    return deps.path.resolve(deps.launchAgentsDir);
  }
  return deps.path.join(deps.homedir(), "Library", "LaunchAgents");
}

function prepareResolved(rawOptions, deps, adapterRootHint) {
  const normalized = normalizeLaunchdOptions(rawOptions);
  if (!normalized.ok) {
    const err = new Error(normalized.errors.join("\n"));
    err.exitCode = EXIT.VALIDATION;
    err.errors = normalized.errors;
    throw err;
  }
  const options = normalized.options;
  const projectDir = resolveProjectDir(
    options.projectDir || rawOptions.projectDir,
    adapterRootHint,
    deps.fs,
    deps.path
  );
  const nodePath = resolveNodePath(options.nodePath || rawOptions.node, deps);
  const runsDir = deps.path.resolve(
    projectDir,
    options.runsDir || rawOptions.runsDir || "runs"
  );
  const baseDir = deps.path.resolve(
    projectDir,
    options.baseDir || rawOptions.baseDir || DEFAULT_BASE_DIR_NAME
  );
  const logDir = deps.path.resolve(
    projectDir,
    options.logDir || rawOptions.logDir || deps.path.join("logs", "launchd")
  );
  const launchAgentsDir = resolveLaunchAgentsDir(deps);

  const paths = buildPathPlan({
    label: options.label,
    projectDir,
    nodePath,
    runsDir,
    baseDir,
    logDir,
    launchAgentsDir,
  });

  // rebuild with absolute path strings from path module (OS separators ok; plist uses as-is)
  const pathPlan = {
    ...paths,
    projectDir,
    nodePath,
    dailyRunnerPath: deps.path.join(projectDir, "daily-runner.js"),
    workingDirectory: projectDir,
    runsDir,
    baseDir,
    logDir,
    launchAgentsDir,
    plistPath: deps.path.join(launchAgentsDir, `${options.label}.plist`),
    configPath: deps.path.join(
      projectDir,
      ".runtime",
      "launchd",
      `${options.label}.json`
    ),
    standardOutPath: deps.path.join(logDir, "daily-runner.stdout.log"),
    standardErrorPath: deps.path.join(logDir, "daily-runner.stderr.log"),
  };

  const plan = buildInstallPlan(options, pathPlan);
  return { options, paths: pathPlan, plan };
}

function runLaunchctl(deps, args) {
  const result = deps.spawnSync("launchctl", args, {
    encoding: "utf8",
    shell: false,
  });
  return {
    args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null,
  };
}

function runPlutilLint(deps, filePath) {
  try {
    const result = deps.spawnSync("plutil", ["-lint", filePath], {
      encoding: "utf8",
      shell: false,
    });
    if (result.error && result.error.code === "ENOENT") {
      return { available: false, ok: null, stdout: "", stderr: "" };
    }
    return {
      available: true,
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } catch (error) {
    return { available: false, ok: null, stdout: "", stderr: String(error) };
  }
}

function planLaunchd(rawOptions, depsOverrides = {}, adapterRootHint) {
  const deps = defaultDeps(depsOverrides);
  // plan allowed on any platform for preview
  const prepared = prepareResolved(
    rawOptions,
    deps,
    adapterRootHint || deps.path.resolve(__dirname, "..")
  );
  const { plan } = prepared;
  return {
    action: plan.action,
    label: plan.label,
    plistPath: plan.plistPath,
    configPath: plan.configPath,
    nodePath: plan.nodePath,
    dailyRunnerPath: plan.dailyRunnerPath,
    workingDirectory: plan.workingDirectory,
    schedule: plan.schedule,
    programArguments: plan.programArguments,
    logPaths: plan.logPaths,
    runsDir: plan.runsDir,
    baseDir: plan.baseDir,
    plistHash: plan.plistHash,
    commands: plan.commands,
    warnings: plan.warnings,
    runAtLoad: plan.runAtLoad,
    replace: plan.replace,
    platform: deps.platform,
  };
}

function generatePlist(rawOptions, depsOverrides = {}, adapterRootHint) {
  const deps = defaultDeps(depsOverrides);
  const prepared = prepareResolved(
    rawOptions,
    deps,
    adapterRootHint || deps.path.resolve(__dirname, "..")
  );
  return {
    plistXml: prepared.plan.plistXml,
    plistHash: prepared.plan.plistHash,
    plan: prepared.plan,
    paths: prepared.paths,
  };
}

function validatePlistFile(inputPath, depsOverrides = {}) {
  const deps = defaultDeps(depsOverrides);
  const abs = deps.path.resolve(inputPath);
  if (!deps.fs.existsSync(abs)) {
    return {
      ok: false,
      errors: [`ファイルが見つかりません: ${abs}`],
      plutil: null,
    };
  }
  const xml = deps.fs.readFileSync(abs, "utf8");
  const core = validatePlistXml(xml);
  const plutil = runPlutilLint(deps, abs);
  const errors = [...core.errors];
  if (plutil.available && plutil.ok === false) {
    errors.push(`plutil -lint 失敗: ${(plutil.stderr || plutil.stdout).trim()}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    extracted: core.extracted,
    plutil,
  };
}

function readConfig(deps, configPath) {
  if (!deps.fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(deps.fs.readFileSync(configPath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function installLaunchd(rawOptions, depsOverrides = {}, adapterRootHint) {
  const deps = defaultDeps(depsOverrides);
  assertDarwin(deps);

  const prepared = prepareResolved(
    rawOptions,
    deps,
    adapterRootHint || deps.path.resolve(__dirname, "..")
  );
  const { options, paths, plan } = prepared;
  const uid = deps.getuid();
  const domain = `gui/${uid}`;
  const warnings = [...plan.warnings];
  const launchctlResults = [];

  // validate plist
  const coreValidation = validatePlistXml(plan.plistXml);
  if (!coreValidation.ok) {
    const err = new Error(coreValidation.errors.join("\n"));
    err.exitCode = EXIT.PLIST_INVALID;
    throw err;
  }

  ensureDir(deps.fs, paths.logDir);
  ensureDir(deps.fs, paths.launchAgentsDir);
  ensureDir(deps.fs, deps.path.dirname(paths.configPath));

  const exists = deps.fs.existsSync(paths.plistPath);
  let backupPath = null;
  let previousXml = null;

  if (exists) {
    previousXml = deps.fs.readFileSync(paths.plistPath, "utf8");
    const previousHash = hashPlist(previousXml);
    if (previousHash === plan.plistHash) {
      // idempotent — ensure loaded
      const print = runLaunchctl(deps, ["print", `${domain}/${paths.label}`]);
      launchctlResults.push({ name: "print", ...print });
      const config = buildAdapterConfig(
        plan,
        readConfig(deps, paths.configPath)?.installedAt ||
          deps.now().toISOString()
      );
      if (!deps.fs.existsSync(paths.configPath)) {
        writeAtomic(
          deps.fs,
          deps.path,
          paths.configPath,
          `${JSON.stringify(config, null, 2)}\n`,
          0o600
        );
      }
      return {
        success: true,
        status: "already-installed",
        label: paths.label,
        plistPath: paths.plistPath,
        configPath: paths.configPath,
        plistHash: plan.plistHash,
        idempotent: true,
        launchctl: launchctlResults,
        warnings,
      };
    }
    if (!options.replace) {
      const err = new Error(
        `既存 plist の内容が異なります: ${paths.plistPath}\n--replace を指定すると置換できます。`
      );
      err.exitCode = EXIT.CONFLICT;
      throw err;
    }

    // replace: backup + bootout
    const stamp = deps.now().toISOString();
    backupPath = deps.path.join(
      paths.launchAgentsDir,
      backupPlistName(paths.label, stamp)
    );
    deps.fs.copyFileSync(paths.plistPath, backupPath);
    const bootout = runLaunchctl(deps, [
      "bootout",
      domain,
      paths.plistPath,
    ]);
    launchctlResults.push({ name: "bootout", ...bootout });
  }

  try {
    writeAtomic(
      deps.fs,
      deps.path,
      paths.plistPath,
      plan.plistXml,
      0o644
    );

    // optional plutil after write
    const plutil = runPlutilLint(deps, paths.plistPath);
    if (plutil.available && plutil.ok === false) {
      throw Object.assign(
        new Error(`plutil -lint 失敗: ${(plutil.stderr || plutil.stdout).trim()}`),
        { exitCode: EXIT.PLIST_INVALID }
      );
    }

    const installedAt = deps.now().toISOString();
    const config = buildAdapterConfig(plan, installedAt);
    writeAtomic(
      deps.fs,
      deps.path,
      paths.configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      0o600
    );

    const bootstrap = runLaunchctl(deps, [
      "bootstrap",
      domain,
      paths.plistPath,
    ]);
    launchctlResults.push({ name: "bootstrap", ...bootstrap });
    if (bootstrap.error || bootstrap.status !== 0) {
      throw Object.assign(
        new Error(
          `launchctl bootstrap 失敗 (exit ${bootstrap.status}): ${(
            bootstrap.stderr || bootstrap.stdout
          ).trim()}`
        ),
        { exitCode: EXIT.LAUNCHCTL, launchctl: bootstrap }
      );
    }

    const print = runLaunchctl(deps, ["print", `${domain}/${paths.label}`]);
    launchctlResults.push({ name: "print", ...print });

    return {
      success: true,
      status: exists ? "replaced" : "installed",
      label: paths.label,
      plistPath: paths.plistPath,
      configPath: paths.configPath,
      backupPath,
      plistHash: plan.plistHash,
      launchctl: launchctlResults,
      warnings,
    };
  } catch (error) {
    // rollback
    const rollbackErrors = [];
    try {
      runLaunchctl(deps, ["bootout", domain, paths.plistPath]);
    } catch (e) {
      rollbackErrors.push(`bootout: ${e.message}`);
    }
    if (backupPath && deps.fs.existsSync(backupPath)) {
      try {
        deps.fs.copyFileSync(backupPath, paths.plistPath);
        runLaunchctl(deps, ["bootstrap", domain, paths.plistPath]);
      } catch (e) {
        rollbackErrors.push(`restore backup: ${e.message}`);
      }
    } else if (!previousXml) {
      try {
        if (deps.fs.existsSync(paths.plistPath)) {
          deps.fs.unlinkSync(paths.plistPath);
        }
      } catch (e) {
        rollbackErrors.push(`remove plist: ${e.message}`);
      }
    }
    if (rollbackErrors.length) {
      error.message = `${error.message}\nrollback: ${rollbackErrors.join("; ")}`;
    }
    throw error;
  }
}

function uninstallLaunchd(rawOptions, depsOverrides = {}, adapterRootHint) {
  const deps = defaultDeps(depsOverrides);
  assertDarwin(deps);

  let label;
  try {
    label = validateLabel(rawOptions.label || DEFAULT_LABEL);
  } catch (error) {
    throw Object.assign(error, { exitCode: EXIT.VALIDATION });
  }

  const projectDir = resolveProjectDir(
    rawOptions.projectDir,
    adapterRootHint || deps.path.resolve(__dirname, ".."),
    deps.fs,
    deps.path
  );
  const launchAgentsDir = resolveLaunchAgentsDir(deps);
  const plistPath = deps.path.join(launchAgentsDir, `${label}.plist`);
  const configPath = deps.path.join(
    projectDir,
    ".runtime",
    "launchd",
    `${label}.json`
  );
  const uid = deps.getuid();
  const domain = `gui/${uid}`;
  const launchctlResults = [];

  const plistExists = deps.fs.existsSync(plistPath);
  const configExists = deps.fs.existsSync(configPath);

  if (!plistExists && !configExists) {
    return {
      success: true,
      status: "not-installed",
      label,
      plistPath,
      configPath,
      idempotent: true,
      launchctl: launchctlResults,
    };
  }

  if (plistExists) {
    const bootout = runLaunchctl(deps, ["bootout", domain, plistPath]);
    launchctlResults.push({ name: "bootout", ...bootout });
    // bootout may fail if not loaded — still try to remove plist if bootout ok or not loaded
    const notLoaded =
      bootout.status !== 0 &&
      /No such process|Could not find|not found/i.test(
        `${bootout.stderr} ${bootout.stdout}`
      );
    if (bootout.status !== 0 && !notLoaded && bootout.error == null) {
      // keep plist
      throw Object.assign(
        new Error(
          `launchctl bootout 失敗 (exit ${bootout.status}): ${(
            bootout.stderr || bootout.stdout
          ).trim()}\nplist は保持しました。`
        ),
        { exitCode: EXIT.LAUNCHCTL, launchctl: bootout }
      );
    }
    deps.fs.unlinkSync(plistPath);
  } else {
    // try bootout by label
    const bootout = runLaunchctl(deps, ["bootout", domain, `${domain}/${label}`]);
    launchctlResults.push({ name: "bootout-label", ...bootout });
  }

  if (configExists) {
    deps.fs.unlinkSync(configPath);
  }

  return {
    success: true,
    status: "uninstalled",
    label,
    plistPath,
    configPath,
    launchctl: launchctlResults,
  };
}

function statusLaunchd(rawOptions, depsOverrides = {}, adapterRootHint) {
  const deps = defaultDeps(depsOverrides);
  assertDarwin(deps);

  let label;
  try {
    label = validateLabel(rawOptions.label || DEFAULT_LABEL);
  } catch (error) {
    throw Object.assign(error, { exitCode: EXIT.VALIDATION });
  }

  const projectDir = resolveProjectDir(
    rawOptions.projectDir,
    adapterRootHint || deps.path.resolve(__dirname, ".."),
    deps.fs,
    deps.path
  );
  const launchAgentsDir = resolveLaunchAgentsDir(deps);
  const plistPath = deps.path.join(launchAgentsDir, `${label}.plist`);
  const configPath = deps.path.join(
    projectDir,
    ".runtime",
    "launchd",
    `${label}.json`
  );

  const plistExists = deps.fs.existsSync(plistPath);
  const configExists = deps.fs.existsSync(configPath);
  const config = configExists ? readConfig(deps, configPath) : null;
  const warnings = [];

  let plistValid = false;
  let actualHash = null;
  let schedule = config?.schedule || null;
  if (plistExists) {
    const xml = deps.fs.readFileSync(plistPath, "utf8");
    const validation = validatePlistXml(xml);
    plistValid = validation.ok;
    actualHash = hashPlist(xml);
    if (!validation.ok) {
      warnings.push(...validation.errors);
    }
  }

  const expectedHash = config?.plistHash || null;
  const hashMatches =
    expectedHash != null && actualHash != null
      ? expectedHash === actualHash
      : null;

  if (hashMatches === false) {
    warnings.push("plist hash が設定と一致しません。");
  }

  const uid = deps.getuid();
  const print = runLaunchctl(deps, ["print", `gui/${uid}/${label}`]);
  const loaded = print.status === 0;
  let lastExitStatus = null;
  if (loaded && print.stdout) {
    const m = /last exit code\s*=\s*(-?\d+)/i.exec(print.stdout);
    if (m) lastExitStatus = Number(m[1]);
  }

  const installed = plistExists && loaded;

  return normalizeStatusResult({
    label,
    installed,
    loaded,
    plistExists,
    configExists,
    plistValid,
    hashMatches,
    schedule,
    paths: {
      plistPath,
      configPath,
      projectDir,
      launchAgentsDir,
    },
    lastExitStatus,
    launchctl: {
      print: {
        status: print.status,
        stdout: print.stdout.slice(0, 2000),
        stderr: print.stderr.slice(0, 500),
      },
    },
    warnings,
  });
}

function printInstalledPlist(rawOptions, depsOverrides = {}, adapterRootHint) {
  const deps = defaultDeps(depsOverrides);
  const label = validateLabel(rawOptions.label || DEFAULT_LABEL);
  const launchAgentsDir = resolveLaunchAgentsDir(deps);
  const plistPath = deps.path.join(launchAgentsDir, `${label}.plist`);
  if (!deps.fs.existsSync(plistPath)) {
    throw Object.assign(new Error(`plist が存在しません: ${plistPath}`), {
      exitCode: EXIT.FAILURE,
    });
  }
  return deps.fs.readFileSync(plistPath, "utf8");
}

module.exports = {
  EXIT,
  defaultDeps,
  planLaunchd,
  generatePlist,
  validatePlistFile,
  installLaunchd,
  uninstallLaunchd,
  statusLaunchd,
  printInstalledPlist,
  prepareResolved,
  runLaunchctl,
  runPlutilLint,
};
