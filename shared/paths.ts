// The eight learning paths. Shared by the UI, the knowledge engine and the classifier.
export type PathInfo = { name: string; slug: string; blurb: string; icon: string; keywords: string[] };

export const PATHS: PathInfo[] = [
  { name: 'Roblox Studio Fundamentals', slug: 'studio', icon: 'studio', blurb: 'Find your way around Studio, build with parts and models, and test your work.', keywords: ['studio', 'explorer', 'properties', 'viewport', 'part', 'model', 'anchored', 'toolbox', 'playtest', 'output window'] },
  { name: 'Luau Programming', slug: 'luau', icon: 'code', blurb: 'The language of Roblox: variables, functions, tables, control flow and modules.', keywords: ['luau', 'variable', 'function', 'table', 'string', 'loop', 'module', 'type annotation', 'ipairs', 'require'] },
  { name: 'UI/UX Development', slug: 'ui', icon: 'ui', blurb: 'Build responsive interfaces that work on phones, tablets and desktops.', keywords: ['screengui', 'frame', 'textlabel', 'textbutton', 'uilistlayout', 'scale', 'offset', 'interface', 'layout', 'touch'] },
  { name: 'Game Building and Level Design', slug: 'level', icon: 'map', blurb: 'Plan readable spaces, guide players and improve levels through playtesting.', keywords: ['level', 'landmark', 'flow', 'route', 'lighting', 'playtest', 'iteration', 'layout', 'spawn'] },
  { name: 'Gameplay Systems', slug: 'gameplay', icon: 'bolt', blurb: 'Events, leaderboards, round loops and animation of game objects.', keywords: ['event', 'connect', 'touched', 'leaderstats', 'round', 'tween', 'tweenservice', 'gameplay', 'players'] },
  { name: 'Backend and Networking', slug: 'backend', icon: 'network', blurb: 'Client-server thinking, RemoteEvents, saving data and defensive design.', keywords: ['remoteevent', 'remotefunction', 'server', 'client', 'datastore', 'validate', 'replicat', 'pcall', 'security'] },
  { name: '3D Art and Animation', slug: 'art', icon: 'cube', blurb: 'Prepare assets for Roblox and play animations from scripts.', keywords: ['mesh', 'texture', 'pivot', 'animation', 'animator', 'rig', 'asset', 'import', 'modeling'] },
  { name: 'Professional Development', slug: 'pro', icon: 'briefcase', blurb: 'Organize projects, debug methodically and present your work honestly.', keywords: ['portfolio', 'organization', 'debug', 'breakpoint', 'workflow', 'documentation', 'team', 'version'] }
];

export const pathByName = (name: string) => PATHS.find((p) => p.name === name);
export const pathBySlug = (slug: string) => PATHS.find((p) => p.slug === slug);
