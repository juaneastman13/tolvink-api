export function buildFreightSelectionItems(filtered: any[]): Array<{ id: string; title: string; description: string }> {
  return filtered.map((f: any) => {
    const grain = f.items?.[0]?.grain || 'N/A';
    const tons = f.items?.[0]?.tons || 0;
    const origin = f.originName || f.originCompany?.name || '?';
    const dest = f.destName || f.destCompany?.name || '?';
    const status = f.statusShort || f.status || 'N/A';
    return {
      id: `freight:${f.id}`,
      title: `${f.code} | ${grain} ${tons}tn`.slice(0, 24),
      description: `${origin} -> ${dest} | ${status}`.slice(0, 72),
    };
  });
}

