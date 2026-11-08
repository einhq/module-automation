/** A label from an id: `switch-0-power` → `Switch 0 power`. */
export const labelOf = (id: string): string => {
  const words = id.replace(/[_:-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : id;
};
