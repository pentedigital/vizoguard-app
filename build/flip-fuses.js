const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
const path = require("path");

/**
 * Flip Electron fuses after packaging to harden the app.
 *
 * - RunAsNode=false: Prevents ELECTRON_RUN_AS_NODE abuse
 * - EnableNodeCliInspectArguments=false: Prevents --inspect/--inspect-brk
 * - EnableEmbeddedAsarIntegrityValidation=true: Validates app.asar integrity (Electron 32+)
 * - OnlyLoadAppFromAsar=true: Prevents loading app from search paths outside ASAR
 * - EnableCookieEncryption=true: Encrypts cookies at rest
 * - EnableNodeOptionsEnvironmentVariable=false: Disables NODE_OPTIONS env var
 */
exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, arch } = context;

  let electronBinaryPath;
  if (electronPlatformName === "darwin") {
    electronBinaryPath = path.join(appOutDir, "Vizoguard.app/Contents/MacOS/Vizoguard");
  } else if (electronPlatformName === "win32") {
    electronBinaryPath = path.join(appOutDir, "Vizoguard.exe");
  } else {
    console.log(`[flip-fuses] Skipping fuse flip for platform: ${electronPlatformName}`);
    return;
  }

  const resetAdHocDarwinSignature = electronPlatformName === "darwin" && arch === 2; // arm64

  await flipFuses(electronBinaryPath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  });

  console.log(`[flip-fuses] Fuses flipped for ${electronPlatformName} (${arch})`);
};
