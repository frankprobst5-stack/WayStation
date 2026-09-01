// US amateur band plan (ARRL, General class privileges shown where a band
// is split by license class — Technician/Extra-only sub-bands are noted
// inline rather than modeled as a separate license-class filter).
const BANDS: { name: string; range: string; notes?: string }[] = [
  { name: "160m", range: "1.800 – 2.000 MHz" },
  { name: "80m", range: "3.500 – 4.000 MHz", notes: "CW/data below ~3.600, phone above ~3.800" },
  { name: "60m", range: "5 channels", notes: "Channelized, USB only, 100W max ERP" },
  { name: "40m", range: "7.000 – 7.300 MHz", notes: "CW/data below ~7.125, phone above" },
  { name: "30m", range: "10.100 – 10.150 MHz", notes: "CW/data only, no phone" },
  { name: "20m", range: "14.000 – 14.350 MHz", notes: "CW/data below ~14.150, phone above" },
  { name: "17m", range: "18.068 – 18.168 MHz" },
  { name: "15m", range: "21.000 – 21.450 MHz", notes: "CW/data below ~21.200, phone above" },
  { name: "12m", range: "24.890 – 24.990 MHz" },
  { name: "10m", range: "28.000 – 29.700 MHz", notes: "CW/data below ~28.300, phone above" },
  { name: "6m", range: "50.000 – 54.000 MHz" },
  { name: "2m", range: "144.000 – 148.000 MHz", notes: "Simplex calling 146.520" },
  { name: "1.25m", range: "222.000 – 225.000 MHz" },
  { name: "70cm", range: "420.000 – 450.000 MHz", notes: "Simplex calling 446.000" },
  { name: "33cm", range: "902.000 – 928.000 MHz" },
  { name: "23cm", range: "1240.000 – 1300.000 MHz" },
];

function BandPlanPanel() {
  return (
    <div className="panel-bandplan">
      {BANDS.map((b) => (
        <div key={b.name} className="bandplan-row">
          <span className="bandplan-name">{b.name}</span>
          <span className="bandplan-range">{b.range}</span>
          {b.notes && <span className="bandplan-notes">{b.notes}</span>}
        </div>
      ))}
      <div className="bandplan-disclaimer">
        US amateur allocations, general reference only — always confirm current FCC Part 97 rules and your license class privileges before transmitting.
      </div>
    </div>
  );
}

export default BandPlanPanel;
