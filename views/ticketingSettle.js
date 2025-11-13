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

    settleForm.addEventListener('submit', function(event) {
        // 1. Get the values
        const cashAmount = parseFloat(cashAmountInput.value) || 0;
        const upiAmount = parseFloat(upiAmountInput.value) || 0;
        const totalCollected = cashAmount + upiAmount;

        // Expected revenue is stored in a variable from the calculateMetrics function scope
        const returnedStartNumber = parseInt(returnedStartNumberInput.value, 10);
        const ticketsSold = returnedStartNumber - distributedStartNumber;
        const expectedRevenue = ticketsSold * ticketRate;

        // 2. Compare the values (using a small tolerance for floating point issues)
        if (Math.abs(totalCollected - expectedRevenue) > 0.01) {
            // 3. If they don't match, show a confirmation dialog
            const confirmed = confirm(
                `Warning: The collected amount (₹${totalCollected.toFixed(2)}) does not match the expected revenue (₹${expectedRevenue.toFixed(2)}).\n\n` +
                `This will be recorded as a shortage/excess. Are you sure you want to continue?`
            );

            // 4. If the user cancels, prevent form submission
            if (!confirmed) {
                event.preventDefault();
            }
        }
    });
});