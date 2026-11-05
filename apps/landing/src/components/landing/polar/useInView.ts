// Adapted from Polar (https://github.com/polarsource/polar), Apache License 2.0.
import { useEffect, useRef, useState } from 'react';

export function useInView(margin = '100px') {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin: margin });
    observer.observe(el);
    return () => observer.disconnect();
  }, [margin]);
  return { ref, inView };
}
