import { type ReactNode, useEffect, useRef } from 'react';

/**
 * Rubriken för ett steg får fokus när steget visas, så att skärmläsare och tangentbord
 * hamnar i början av det nya innehållet i stället för kvar på en knapp som inte finns längre.
 */
export function StepHeading({
  children,
  onBack,
}: {
  readonly children: ReactNode;
  readonly onBack?: (() => void) | undefined;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="step-heading">
      {onBack !== undefined && (
        <button type="button" className="back" onClick={onBack} aria-label="Tillbaka">
          ←
        </button>
      )}
      <h2 id="step-title" ref={ref} tabIndex={-1}>
        {children}
      </h2>
    </div>
  );
}
