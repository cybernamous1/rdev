import { useEffect, useState } from 'react';
import { AppProvider } from './app/context.tsx';
import { NotifyProvider } from './app/helpers.tsx';
import { useRoute } from './app/router.ts';
import { Shell } from './app/Shell.tsx';
import { Splash } from './components/Splash.tsx';
import type { InitResult } from './services/initialize.ts';
import { Home } from './pages/Home.tsx';
import { Paths, PathDetail, NotFound } from './pages/Paths.tsx';
import { Docs } from './pages/Docs.tsx';
import { Lesson } from './pages/Lesson.tsx';
import { Search } from './pages/Search.tsx';
import { Playground } from './pages/Playground.tsx';
import { Explorer } from './pages/Explorer.tsx';
import { Bookmarks, Progress, Settings, About } from './pages/Personal.tsx';

function Pages() {
  const route = useRoute();
  const [page, sub] = route.segments;
  useEffect(() => { if (!location.hash) location.replace('#/home'); }, []);
  switch (page || 'home') {
    case 'home': return <Shell route={route}><Home /></Shell>;
    case 'paths': return <Shell route={route}>{sub ? <PathDetail route={route} /> : <Paths />}</Shell>;
    case 'docs': return <Shell route={route}><Docs route={route} /></Shell>;
    case 'lesson': return <Shell route={route}><Lesson route={route} /></Shell>;
    case 'search': return <Shell route={route}><Search route={route} /></Shell>;
    case 'playground': return <Shell route={route}><Playground /></Shell>;
    case 'explorer': return <Shell route={route}><Explorer route={route} /></Shell>;
    case 'bookmarks': return <Shell route={route}><Bookmarks /></Shell>;
    case 'progress': return <Shell route={route}><Progress /></Shell>;
    case 'settings': return <Shell route={route}><Settings /></Shell>;
    case 'about': return <Shell route={route}><About route={route} /></Shell>;
    default: return <Shell route={route}><NotFound /></Shell>;
  }
}

export default function App() {
  const [init, setInit] = useState<InitResult | null>(null);
  if (!init) return <Splash onReady={setInit} />;
  return <AppProvider init={init}><NotifyProvider><Pages /></NotifyProvider></AppProvider>;
}
