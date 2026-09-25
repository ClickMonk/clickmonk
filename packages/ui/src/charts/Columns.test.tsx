import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Columns } from './Columns'

const buckets = [
  { label: 'Mon 5 Oct', value: 12 },
  { label: 'Tue 6 Oct', value: 0 },
  { label: 'Wed 7 Oct', value: 37 },
]

describe('the column chart', () => {
  it('says what it shows in one sentence', () => {
    render(<Columns buckets={buckets} unit="clicks" span="day" label="Clicks by day" />)
    expect(
      screen.getByRole('img', {
        name: 'Clicks by day: 49 clicks over 3 days, the most 37 on Wed 7 Oct',
      }),
    ).toBeInTheDocument()
  })

  it('draws every bucket, the empty one included', () => {
    const { container } = render(
      <Columns buckets={buckets} unit="clicks" span="day" label="Clicks by day" />,
    )
    expect(container.querySelectorAll('rect[data-bucket]')).toHaveLength(3)
    expect(container.querySelector('rect[data-bucket="1"] title')).toHaveTextContent(
      'Tue 6 Oct: 0 clicks',
    )
  })

  it('labels its axis from zero to a round maximum', () => {
    render(<Columns buckets={buckets} unit="clicks" span="day" label="Clicks by day" />)
    const axis = screen.getByTestId('axis')
    expect(
      within(axis)
        .getAllByText(/\d/)
        .map((e) => e.textContent),
    ).toEqual(['50', '25', '0'])
  })

  // jsdom does not hide a closed <details> from the accessibility queries, so
  // what the click changes is asserted directly: the disclosure is shut, then
  // open.
  it('shows the numbers in a table on request', async () => {
    render(<Columns buckets={buckets} unit="clicks" span="day" label="Clicks by day" />)
    const disclosure = screen.getByText('Show the numbers').closest('details') as HTMLDetailsElement
    expect(disclosure.open).toBe(false)
    await userEvent.setup().click(screen.getByText('Show the numbers'))
    expect(disclosure.open).toBe(true)
    const rows = within(screen.getByRole('table'))
      .getAllByRole('row')
      .map((r) => r.textContent)
    expect(rows).toEqual(['WhenClicks', 'Mon 5 Oct12', 'Tue 6 Oct0', 'Wed 7 Oct37'])
  })
})
