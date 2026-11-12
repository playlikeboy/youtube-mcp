/** Tools that manage which YouTube channels this server can act as. */

function accountTools_() {
  const aliasProp = strProp_('Short name for the account: letters, digits, "_" or "-".');
  return [
    defineTool_({
      name: 'youtube_accounts_list',
      title: 'List connected accounts',
      description:
        'List the YouTube accounts this server can act as. "owner" is the Google account that deployed the ' +
        'script; the others were added with youtube_accounts_connect. Shows which one is the default.',
      kind: 'read',
      noAccount: true,
      props: {},
      handler: function () {
        return { accounts: listAccounts_(), oauthClientConfigured: isOAuthConfigured_() };
      },
    }),
    defineTool_({
      name: 'youtube_accounts_connect',
      title: 'Connect a YouTube channel',
      description:
        'Start connecting another YouTube channel (any Google account or brand channel). Returns an authUrl the ' +
        'channel owner must open in a browser to approve access. Reusing an alias replaces that connection.',
      kind: 'write',
      noAccount: true,
      props: { alias: aliasProp },
      required: ['alias'],
      handler: function (args) {
        return startAccountConnection_(args.alias);
      },
    }),
    defineTool_({
      name: 'youtube_accounts_remove',
      title: 'Disconnect a YouTube channel',
      description: 'Remove a connected account and revoke its stored refresh token. The "owner" account cannot be removed.',
      kind: 'delete',
      noAccount: true,
      props: { alias: aliasProp },
      required: ['alias'],
      handler: function (args) {
        return removeAccount_(args.alias);
      },
    }),
    defineTool_({
      name: 'youtube_accounts_set_default',
      title: 'Set the default account',
      description: 'Choose which account is used when a tool call has no "account" argument. Use "owner" for the script owner.',
      kind: 'write',
      noAccount: true,
      props: { alias: aliasProp },
      required: ['alias'],
      handler: function (args) {
        return setDefaultAccount_(args.alias);
      },
    }),
  ];
}
