import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Tab Intentions (POC)',
    description: 'Infer why each open tab is still open, so you can close it with confidence.',
    // Public key only: pins the extension ID to EXTENSION_ID (lib/protocol.ts) for every unpacked install,
    // which the native messaging host manifest and the companion's origin check depend on.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAp3VBeaWidN9JFqLA6m9ZAZrpWaG1c23SIbCLB5o4la0Re8cstHEI4y7BCdQlp5uwR8q6vp4qY0B4g/goKc2ln+CPemlqHxLUMDlFT2dgnYaOaFJcuJBtnmBXGJ18zNw+0IsrQk1x21ou3LYX9zA6S+T/iIKR+U2ShdxQHbLRP5J66kFAKXcddp7WCxZ4qhXLMRaennSwiwok3+WacBJWR+56pZOk31HsYrsFYNFpnP5oyJlkFNbAE/r3p7UtVmpz5hvNJhkPcn14/K8LeMbbEj+6mTjf0Z/CePpm2PdNLCjdx06fPX74M9QxIHYzgouyXh8JP/aw6MoKAHsAp11ZDwIDAQAB',
    permissions: ['tabs', 'tabGroups', 'scripting', 'storage', 'sidePanel', 'alarms', 'nativeMessaging', 'sessions'],
    // POC: read any page the agent asks for. A real build would use optional_host_permissions.
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Tab Intentions' },
  },
});
