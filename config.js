// Built-in default sync target so every device works with zero setup.
// The publishable key is client-safe by design (it only does what the database's
// row-level-security rules allow). To point at a different database, change these
// or use the in-app Sync dialog (which overrides this).
window.JOSHCARDS_SYNC = {
  url: 'https://vyangxmetscrogyspacd.supabase.co',
  key: 'sb_publishable_F6Fq7p9Jl8Nl7FB2isASmw_9peA-kTJ'
};
