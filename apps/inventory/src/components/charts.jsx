import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const BRAND = '#134b8e'
const BRAND_LIGHT = '#3698d4'
const TARGET = '#cbd5e1'
const money3 = (v) => (v == null ? '—' : '$' + Number(v).toFixed(3))
const money2 = (v) => (v == null ? '—' : '$' + Number(v).toFixed(2))

const tooltipStyle = {
  borderRadius: 12,
  border: '1px solid #e2e8f0',
  boxShadow: '0 8px 24px -8px rgba(15,23,42,.2)',
  fontSize: 12,
  fontWeight: 600,
}

// Actual vs Target CPC by location (Master dashboard).
export function CpcByLocationChart({ data }) {
  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 40 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef2f7" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 10, fill: '#64748b' }}
            angle={-38}
            textAnchor="end"
            interval={0}
            height={70}
          />
          <YAxis tickFormatter={money3} tick={{ fontSize: 11, fill: '#94a3b8' }} width={58} axisLine={false} tickLine={false} />
          <Tooltip formatter={(v) => money3(v)} contentStyle={tooltipStyle} cursor={{ fill: 'rgba(19,75,142,0.04)' }} />
          <Legend wrapperStyle={{ fontSize: 12, fontWeight: 600 }} />
          <Bar dataKey="actual" name="Actual CPC" fill={BRAND} radius={[5, 5, 0, 0]} maxBarSize={26} isAnimationActive={false} />
          <Bar dataKey="target" name="Target CPC" fill={TARGET} radius={[5, 5, 0, 0]} maxBarSize={26} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// Chemical cost over time for a single location.
export function CostOverTimeChart({ data }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <defs>
            <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={BRAND_LIGHT} stopOpacity={0.35} />
              <stop offset="100%" stopColor={BRAND_LIGHT} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef2f7" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748b' }} />
          <YAxis tickFormatter={money2} tick={{ fontSize: 11, fill: '#94a3b8' }} width={70} axisLine={false} tickLine={false} />
          <Tooltip formatter={(v) => money2(v)} contentStyle={tooltipStyle} />
          <Area
            type="monotone"
            dataKey="cost"
            name="Chemical cost"
            stroke={BRAND}
            strokeWidth={2.5}
            fill="url(#costFill)"
            dot={{ r: 3, fill: BRAND, strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// CPC trend (actual vs target) for a location.
export function CpcOverTimeChart({ data }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <defs>
            <linearGradient id="cpcFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={BRAND} stopOpacity={0.25} />
              <stop offset="100%" stopColor={BRAND} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef2f7" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748b' }} />
          <YAxis tickFormatter={money3} tick={{ fontSize: 11, fill: '#94a3b8' }} width={62} axisLine={false} tickLine={false} />
          <Tooltip formatter={(v) => money3(v)} contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 12, fontWeight: 600 }} />
          <Area
            type="monotone"
            dataKey="actual"
            name="Actual CPC"
            stroke={BRAND}
            strokeWidth={2.5}
            fill="url(#cpcFill)"
            dot={{ r: 3, fill: BRAND, strokeWidth: 0 }}
          />
          <Area
            type="monotone"
            dataKey="target"
            name="Target CPC"
            stroke="#94a3b8"
            strokeWidth={2}
            strokeDasharray="6 4"
            fill="none"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
