const NATO_MORSE: [string, string, string][] = [
  ["A", "Alpha", "•—"], ["B", "Bravo", "—•••"], ["C", "Charlie", "—•—•"], ["D", "Delta", "—••"],
  ["E", "Echo", "•"], ["F", "Foxtrot", "••—•"], ["G", "Golf", "——•"], ["H", "Hotel", "••••"],
  ["I", "India", "••"], ["J", "Juliet", "•———"], ["K", "Kilo", "—•—"], ["L", "Lima", "•—••"],
  ["M", "Mike", "——"], ["N", "November", "—•"], ["O", "Oscar", "———"], ["P", "Papa", "•——•"],
  ["Q", "Quebec", "——•—"], ["R", "Romeo", "•—•"], ["S", "Sierra", "•••"], ["T", "Tango", "—"],
  ["U", "Uniform", "••—"], ["V", "Victor", "•••—"], ["W", "Whiskey", "•——"], ["X", "X-ray", "—••—"],
  ["Y", "Yankee", "—•——"], ["Z", "Zulu", "——••"],
];

function SpectrumReferencePanel() {
  return (
    <div className="panel-reference">
      <section>
        <h3>VHF/UHF National Simplex</h3>
        <div className="ref-line">2m: <strong>146.520 MHz</strong></div>
        <div className="ref-line">70cm: <strong>446.000 MHz</strong></div>
      </section>

      <section>
        <h3>MURS (license-free)</h3>
        <div className="ref-line">CH1: 151.820 &nbsp; CH2: 151.880 &nbsp; CH3: 151.940 MHz (narrowband)</div>
        <div className="ref-line">CH4: 154.570 &nbsp; CH5: 154.600 MHz (wideband)</div>
      </section>

      <section>
        <h3>GMRS</h3>
        <div className="ref-line">Simplex: 462.550–462.725 MHz</div>
        <div className="ref-line">Repeater inputs: 467.550–467.725 MHz</div>
      </section>

      <section>
        <h3>NOAA Weather Radio</h3>
        <div className="ref-line">162.400 / 162.425 / 162.450 / 162.475 / 162.500 / 162.525 / 162.550 MHz</div>
      </section>

      <section>
        <h3>NATO Phonetic &amp; Morse</h3>
        <div className="nato-grid">
          {NATO_MORSE.map(([letter, word, morse]) => (
            <div key={letter} className="nato-cell">
              <span className="nato-letter">{letter}</span>
              <span className="nato-word">{word}</span>
              <span className="nato-morse">{morse}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default SpectrumReferencePanel;
