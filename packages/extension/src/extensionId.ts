/**
 * The extension's identity. Chrome derives the extension ID from the manifest's public `key`, so
 * every unpacked install (any machine, any checkout) gets the same ID. The companion's native
 * messaging host manifest allows exactly this ID (architecture A3), so it must never change.
 *
 * The POC at the repo root uses the same key, so only one of the two can be loaded at a time.
 *
 * The ID itself lives in core (`EXTENSION_ID`), where the companion reads it too.
 */
import { EXTENSION_ID as CORE_EXTENSION_ID } from "@wherefore/core"

/** Public key only (base64 DER SubjectPublicKeyInfo). The private key is not needed for unpacked installs. */
export const PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAp3VBeaWidN9JFqLA6m9ZAZrpWaG1c23SIbCLB5o4la0Re8cstHEI4y7BCdQlp5uwR8q6vp4qY0B4g/goKc2ln+CPemlqHxLUMDlFT2dgnYaOaFJcuJBtnmBXGJ18zNw+0IsrQk1x21ou3LYX9zA6S+T/iIKR+U2ShdxQHbLRP5J66kFAKXcddp7WCxZ4qhXLMRaennSwiwok3+WacBJWR+56pZOk31HsYrsFYNFpnP5oyJlkFNbAE/r3p7UtVmpz5hvNJhkPcn14/K8LeMbbEj+6mTjf0Z/CePpm2PdNLCjdx06fPX74M9QxIHYzgouyXh8JP/aw6MoKAHsAp11ZDwIDAQAB"

/** The ID Chrome derives from {@link PUBLIC_KEY}. A test checks that the two agree. */
export const EXTENSION_ID: string = CORE_EXTENSION_ID
