document.addEventListener('DOMContentLoaded', () => {
    const settleForm = document.getElementById('settleForm');
    const returnedStartNumberInput = document.getElementById('returned_start_number');
    const ticketsSoldInput = document.getElementById('tickets_sold');
    const expectedRevenueInput = document.getElementById('expected_revenue');
    const cashAmountInput = document.getElementById('cash_amount');
    const upiAmountInput = document.getElementById('upi_amount');
    
    // Read values from the data-* attributes on the form for robustness.
    const ticketRate = parseFloat(settleForm.dataset.ticketRate);
    const distributedStartNumber = parseInt(settleForm.dataset.startNumber, 10);


    function calculateMetrics() {
        const returnedStartNumber = parseInt(returnedStartNumberInput.value, 10);

        if (isNaN(returnedStartNumber) || isNaN(distributedStartNumber) || isNaN(ticketRate)) {
            ticketsSoldInput.value = '';
            expectedRevenueInput.value = '';
            cashAmountInput.value = '0';
            return;
        }

        const ticketsSold = returnedStartNumber - distributedStartNumber;
        const expectedRevenue = ticketsSold * ticketRate;

        ticketsSoldInput.value = ticketsSold >= 0 ? ticketsSold : 'Invalid';
        expectedRevenueInput.value = `₹${expectedRevenue.toFixed(2)}`;
        cashAmountInput.value = expectedRevenue > 0 ? expectedRevenue.toFixed(2) : '0'; // Pre-fill cash amount
        upiAmountInput.value = '0'; // Reset UPI on change
    }

    returnedStartNumberInput.addEventListener('input', calculateMetrics);
    calculateMetrics(); // Initial calculation on page load
});