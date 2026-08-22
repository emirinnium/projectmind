'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { href: '/', label: 'Overview', icon: '📊' },
  { href: '/debt', label: 'Debt', icon: '⚠️' },
  { href: '/security', label: 'Security', icon: '🔒' },
  { href: '/hotspots', label: 'Hotspots', icon: '🔥' },
  { href: '/embeddings', label: 'Embeddings', icon: '🧬' },
  { href: '/agents', label: 'Agents', icon: '🤖' },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 border-r border-gray-200 bg-white">
      <div className="border-b border-gray-200 p-4">
        <div className="flex items-center gap-3">
          <Image
            src="/icon-128x128.png"
            alt="ProjectMind Logo"
            width={32}
            height={32}
            className="rounded-lg"
          />
          <div>
            <h2 className="text-lg font-bold text-primary-700">ProjectMind</h2>
            <p className="text-xs text-gray-500">Code Intelligence</p>
          </div>
        </div>
      </div>
      <nav className="p-4">
        <ul className="space-y-1">
          {navItems.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  pathname === item.href
                    ? 'bg-primary-50 text-primary-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
