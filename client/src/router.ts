import { useEffect, useState } from "react";

function currentPath(): string {
  return window.location.hash.slice(1) || "/orders";
}

export function useRoute(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return path;
}

export function navigate(to: string): void {
  window.location.hash = to;
}

export function href(to: string): string {
  return `#${to}`;
}
